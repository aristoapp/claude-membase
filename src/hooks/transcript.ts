import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureDataDir } from "../config/index.js";
import { sanitizeMembaseText, truncateText } from "../sanitize/index.js";
import type { CaptureRecord, HookInput } from "../types.js";

type CaptureDraft = Omit<CaptureRecord, "capture_id" | "created_at"> & {
  sessionId?: string;
};

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface TranscriptCaptureResult {
  lineCount: number;
  capture: CaptureDraft | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function cursorPath(input: HookInput): string | null {
  if (!input.transcript_path) return null;
  const session = input.session_id ?? "unknown";
  const key = stableHash(`${session}:${input.transcript_path}`);
  return join(ensureDataDir(), "transcripts", `${key}.json`);
}

function readCursor(path: string | null): number {
  if (!path || !existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      line_count?: unknown;
    };
    return typeof parsed.line_count === "number" && parsed.line_count > 0
      ? Math.floor(parsed.line_count)
      : 0;
  } catch {
    return 0;
  }
}

export function markTranscriptCaptured(
  input: HookInput,
  lineCount: number,
): void {
  const path = cursorPath(input);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ line_count: lineCount })}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function normalizeRole(value: unknown): TranscriptMessage["role"] | null {
  if (value === "user" || value === "human") return "user";
  if (value === "assistant" || value === "agent") return "assistant";
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const obj = objectValue(item);
      const type = typeof obj.type === "string" ? obj.type : "";
      if (type && type !== "text") return "";
      return typeof obj.text === "string" ? obj.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageFromEntry(entry: unknown): TranscriptMessage | null {
  const obj = objectValue(entry);
  const message = objectValue(obj.message);
  const role = normalizeRole(obj.role ?? message.role ?? obj.type);
  if (!role) return null;
  const rawText = textFromContent(message.content ?? obj.content ?? obj.text);
  const text = sanitizeMembaseText(rawText);
  if (text.length < 2) return null;
  return { role, text };
}

function formatTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `### ${label}\n${message.text}`;
    })
    .join("\n\n");
}

function buildContent(args: {
  input: HookInput;
  project?: string;
  messages: TranscriptMessage[];
  capturedAt: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return [
    "# Claude Code Conversation Capture",
    "",
    `- Captured at: ${args.capturedAt}`,
    ...(args.project ? [`- Project: ${args.project}`] : []),
    `- Transcript lines: ${args.lineStart + 1}-${args.lineEnd}`,
    "",
    "## Transcript",
    "",
    formatTranscript(args.messages),
  ].join("\n");
}

export function readTranscriptCapture(
  input: HookInput,
  project?: string,
): TranscriptCaptureResult | null {
  if (!input.transcript_path || !existsSync(input.transcript_path)) return null;
  const raw = readFileSync(input.transcript_path, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const cursor = Math.min(readCursor(cursorPath(input)), lines.length);
  const delta = lines.slice(cursor);
  const messages = delta
    .map((line) => {
      try {
        return messageFromEntry(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((message): message is TranscriptMessage => Boolean(message));
  if (messages.length === 0) {
    return { lineCount: lines.length, capture: null };
  }

  const capturedAt = new Date().toISOString();
  const content = buildContent({
    input,
    project,
    messages,
    capturedAt,
    lineStart: cursor,
    lineEnd: lines.length,
  });
  if (content.length < 20) {
    return { lineCount: lines.length, capture: null };
  }
  return {
    lineCount: lines.length,
    capture: {
      capture_kind: "conversation_transcript",
      title: `Claude Code conversation capture - ${capturedAt}`,
      content,
      display_summary: truncateText(content, 180),
      project,
      sessionId: input.session_id,
      metadata: {
        project_slug: project ?? null,
        transcript_line_start: cursor + 1,
        transcript_line_end: lines.length,
      },
    },
  };
}
