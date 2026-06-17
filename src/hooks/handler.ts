import { createClient } from "../api/client.js";
import type { MembaseClient } from "../api/client.js";
import { loadConfig, readTokens, writeTokens } from "../config/index.js";
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_RECALL_TIMEOUT_MS,
  PREFETCH_BROADER_MEMORY_LIMIT,
  PREFETCH_MEMORY_LIMIT,
  PREFETCH_PROJECT_MEMORY_LIMIT,
  PREFETCH_WIKI_LIMIT,
} from "../constants.js";
import { buildRecallContext } from "../format/index.js";
import type { RecallMemoryGroup } from "../format/index.js";
import { resolveProjectSlug } from "../project/index.js";
import {
  isCasualChat,
  isOperationalMessage,
  sanitizeRecallQuery,
} from "../sanitize/index.js";
import { enqueueCapture, flushSpool } from "../spool/index.js";
import type { HookInput } from "../types.js";
import { buildSessionStartContext } from "./session-start.js";
import { markTranscriptCaptured, readTranscriptCapture } from "./transcript.js";
import type { EpisodeBundle } from "../types.js";

const SESSION_FETCH_TIMEOUT_MS = 1_800;
const ASYNC_FLUSH_TIMEOUT_MS = DEFAULT_API_TIMEOUT_MS;
const ASYNC_FLUSH_LIMIT = 3;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function outputAdditionalContext(
  text: string,
  event = "UserPromptSubmit",
): void {
  if (!text.trim()) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: text,
      },
    }),
  );
}

function extractPrompt(input: HookInput): string {
  if (typeof input.prompt === "string") return input.prompt;
  if (typeof input.user_prompt === "string") return input.user_prompt;
  return "";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    }),
  ]);
}

function captureMetadata(projectSlug?: string) {
  return {
    project_slug: projectSlug ?? null,
  };
}

interface RawRecallMemoryGroup {
  title: string;
  limit: number;
  bundles: EpisodeBundle[];
}

function memoryKey(bundle: EpisodeBundle): string {
  return (
    bundle.episode.uuid ||
    bundle.episode.name ||
    bundle.episode.summary ||
    JSON.stringify(bundle.episode)
  );
}

function selectRecallMemoryGroup(
  group: RawRecallMemoryGroup,
  seen: Set<string>,
): RecallMemoryGroup {
  const memories: EpisodeBundle[] = [];
  for (const bundle of group.bundles) {
    const key = memoryKey(bundle);
    if (seen.has(key)) continue;
    if (memories.length >= group.limit) continue;
    seen.add(key);
    memories.push(bundle);
  }
  return {
    title: group.title,
    memories,
    capped: group.bundles.length > group.limit,
  };
}

async function fetchRecallMemoryGroup(
  client: MembaseClient,
  args: {
    title: string;
    query: string;
    limit: number;
    project?: string;
  },
): Promise<RawRecallMemoryGroup> {
  const bundles = await client.searchMemory({
    query: args.query,
    limit: args.limit + 1,
    project: args.project,
  });
  return {
    title: args.title,
    limit: args.limit,
    bundles,
  };
}

async function handleSessionStart(input: HookInput): Promise<void> {
  const config = loadConfig();
  const tokens = readTokens();
  if (!tokens) {
    if (config.sessionStartContext !== "off") {
      outputAdditionalContext(
        "Membase is installed but not connected. Run /membase:login to enable memory.",
        "SessionStart",
      );
    }
    return;
  }
  const client = createClient(config.apiUrl, tokens, writeTokens, {
    timeoutMs: SESSION_FETCH_TIMEOUT_MS,
  });
  const projectSlug = resolveProjectSlug(input.cwd, config);
  await withTimeout(
    flushSpool(client, 1),
    SESSION_FETCH_TIMEOUT_MS + 200,
  ).catch(() => undefined);
  if (config.sessionStartContext === "off") return;
  const profile = await withTimeout(
    client.getProfile(),
    SESSION_FETCH_TIMEOUT_MS,
  ).catch(() => undefined);
  const context = buildSessionStartContext({
    mode: config.sessionStartContext,
    projectSlug,
    profile,
  });
  if (context) {
    outputAdditionalContext(context, "SessionStart");
  }
}

async function handleUserPromptSubmit(input: HookInput): Promise<void> {
  const config = loadConfig();
  if (!config.autoRecall) return;
  const tokens = readTokens();
  if (!tokens) return;
  const prompt = sanitizeRecallQuery(extractPrompt(input));
  if (!prompt || prompt.length < 8) return;
  if (isCasualChat(prompt) || isOperationalMessage(prompt)) return;
  const client = createClient(config.apiUrl, tokens, writeTokens, {
    timeoutMs: DEFAULT_RECALL_TIMEOUT_MS,
  });
  const project = resolveProjectSlug(input.cwd, config);
  const memoryFetches = [
    ...(project
      ? [
          withTimeout(
            fetchRecallMemoryGroup(client, {
              title: `Project memories (project=${project})`,
              query: prompt,
              limit: PREFETCH_PROJECT_MEMORY_LIMIT,
              project,
            }),
            DEFAULT_RECALL_TIMEOUT_MS,
          ),
        ]
      : []),
    withTimeout(
      fetchRecallMemoryGroup(client, {
        title: project ? "Broader memories (unscoped search)" : "Memories",
        query: prompt,
        limit: project ? PREFETCH_BROADER_MEMORY_LIMIT : PREFETCH_MEMORY_LIMIT,
      }),
      DEFAULT_RECALL_TIMEOUT_MS,
    ),
  ];
  const [memoryResults, wikiResult] = await Promise.all([
    Promise.allSettled(memoryFetches),
    config.autoWikiRecall
      ? withTimeout(
          client.searchWiki({ query: prompt, limit: PREFETCH_WIKI_LIMIT }),
          DEFAULT_RECALL_TIMEOUT_MS,
        ).catch(() => [])
      : Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  const memoryGroups = memoryResults
    .filter(
      (result): result is PromiseFulfilledResult<RawRecallMemoryGroup> =>
        result.status === "fulfilled",
    )
    .map((result) => selectRecallMemoryGroup(result.value, seen))
    .filter((group) => group.memories.length > 0);
  const context = buildRecallContext(
    memoryGroups,
    wikiResult,
    config.maxRecallChars,
  );
  outputAdditionalContext(context);
}

async function spoolTranscript(input: HookInput): Promise<void> {
  const config = loadConfig();
  if (config.captureMode !== "wiki") return;
  const project = resolveProjectSlug(input.cwd, config);
  const result = readTranscriptCapture(input, project);
  if (!result) return;
  if (!result.capture) {
    markTranscriptCaptured(input, result.lineCount);
    return;
  }
  const queued = enqueueCapture({
    ...result.capture,
    metadata: {
      ...captureMetadata(project),
      ...result.capture.metadata,
    },
  });
  if (queued) {
    markTranscriptCaptured(input, result.lineCount);
  }
}

async function main(): Promise<void> {
  const explicitEvent = process.argv[2];
  const raw = await readStdin();
  const input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  input.hook_event_name =
    explicitEvent || (input.hook_event_name as string | undefined);
  const event = input.hook_event_name;
  if (event === "SessionStart") await handleSessionStart(input);
  if (event === "UserPromptSubmit") await handleUserPromptSubmit(input);
  if (event === "Stop" || event === "SessionEnd") {
    const config = loadConfig();
    const tokens = readTokens();
    await spoolTranscript(input);
    if (tokens) {
      const client = createClient(config.apiUrl, tokens, writeTokens, {
        timeoutMs: ASYNC_FLUSH_TIMEOUT_MS,
      });
      await flushSpool(client, ASYNC_FLUSH_LIMIT).catch(() => undefined);
    }
  }
}

main().catch(() => {
  process.exit(0);
});
