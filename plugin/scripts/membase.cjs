#!/usr/bin/env node
"use strict";

// src/cli.ts
var import_node_fs4 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path4 = require("node:path");
var import_promises = require("node:readline/promises");

// src/constants.ts
var PLUGIN_NAME = "claude-membase";
var PLUGIN_VERSION = "0.2.0";
var DEFAULT_API_URL = "https://api.membase.so";
var DEFAULT_MCP_URL = "https://mcp.membase.so/mcp";
var MEMORY_SOURCE = "claude-code";
var USER_AGENT = `membase-claude-code/${PLUGIN_VERSION}`;
var DEFAULT_API_TIMEOUT_MS = 18e4;
var DEFAULT_MAX_RECALL_CHARS = 4e3;
var MAX_RECALL_CHARS = 16e3;
var MIN_RECALL_CHARS = 500;

// src/types.ts
var MembaseApiError = class extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "MembaseApiError";
  }
};

// src/wiki-project.ts
function normalizeProjectValue(value) {
  if (value === void 0) return void 0;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function resolveWikiProjectInput(args) {
  const project = normalizeProjectValue(args.project);
  const collection = normalizeProjectValue(args.collection);
  if (project === void 0 && collection === void 0) return {};
  if (project !== void 0 && collection !== void 0) {
    if (project !== collection) {
      return {
        error: "project and legacy collection must match when both are provided"
      };
    }
    return { value: project };
  }
  return { value: project !== void 0 ? project : collection };
}

// src/api/client.ts
var MembaseClient = class {
  tokens;
  refreshPromise = null;
  apiUrl;
  timeoutMs;
  onTokenRefresh;
  constructor(options) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.tokens = options.tokens;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.onTokenRefresh = options.onTokenRefresh;
  }
  async doRefresh() {
    if (!this.tokens.refreshToken || !this.tokens.clientId) {
      throw new MembaseApiError("Not authenticated", 401);
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
      client_id: this.tokens.clientId
    });
    const response = await fetch(`${this.apiUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new MembaseApiError("Token refresh failed", response.status, text);
    }
    const data = await response.json();
    this.tokens = {
      ...this.tokens,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.tokens.refreshToken,
      expiresAt: data.expires_in ? Math.floor(Date.now() / 1e3) + data.expires_in : void 0,
      scope: data.scope ?? this.tokens.scope
    };
    this.onTokenRefresh?.(this.tokens);
  }
  async refreshAccessToken() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }
  async rawFetch(path, options = {}) {
    return fetch(`${this.apiUrl}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.tokens.accessToken}`,
        "User-Agent": USER_AGENT,
        ...options.headers ?? {}
      }
    });
  }
  async authorizedFetch(path, options = {}) {
    let response = await this.rawFetch(path, options);
    if (response.status === 401 && this.tokens.refreshToken) {
      await response.body?.cancel();
      await this.refreshAccessToken();
      response = await this.rawFetch(path, options);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new MembaseApiError(
        `Membase API error ${response.status}`,
        response.status,
        text
      );
    }
    return response;
  }
  async request(path, options = {}) {
    const response = await this.authorizedFetch(path, options);
    if (response.status === 204) return void 0;
    return await response.json();
  }
  async searchMemory(args) {
    const params = new URLSearchParams({
      query: args.query,
      limit: String(args.limit ?? 20),
      format: "bundles"
    });
    if (args.offset !== void 0) params.set("offset", String(args.offset));
    if (args.date_from) params.set("date_from", args.date_from);
    if (args.date_to) params.set("date_to", args.date_to);
    if (args.timezone) params.set("timezone", args.timezone);
    if (args.project) params.set("project", args.project);
    for (const source of args.sources ?? []) params.append("sources", source);
    const data = await this.request(
      `/memory/search?${params.toString()}`
    );
    return data.episodes ?? [];
  }
  async ingestMemory(args) {
    return this.request("/memory/ingest", {
      method: "POST",
      body: JSON.stringify({
        content: args.content,
        display_summary: args.display_summary,
        metadata: args.metadata,
        project: args.project,
        source: MEMORY_SOURCE,
        channel: "mcp"
      })
    });
  }
  async getProfile() {
    return this.request("/user/settings");
  }
  async getRecentMemories(limit = 10) {
    return this.searchMemory({ query: "", limit });
  }
  async searchWiki(args) {
    const projectInput = resolveWikiProjectInput(args);
    if (projectInput.error) {
      throw new MembaseApiError(projectInput.error, 400);
    }
    const params = new URLSearchParams({
      query: args.query,
      limit: String(args.limit ?? 10)
    });
    if (projectInput.value) params.set("project", projectInput.value);
    const data = await this.request(
      `/wiki/search?${params.toString()}`
    );
    return data.documents ?? [];
  }
  async addWiki(args) {
    const projectInput = resolveWikiProjectInput(args);
    if (projectInput.error) {
      throw new MembaseApiError(projectInput.error, 400);
    }
    return this.request("/wiki/documents", {
      method: "POST",
      body: JSON.stringify({
        title: args.title,
        content: args.content,
        source: MEMORY_SOURCE,
        source_metadata: {
          ...args.source_metadata ?? {},
          plugin_name: PLUGIN_NAME,
          plugin_version: PLUGIN_VERSION,
          host: "claude-code"
        },
        project: projectInput.value ?? void 0
      })
    });
  }
  async updateWiki(args) {
    const projectInput = resolveWikiProjectInput(args);
    if (projectInput.error) {
      throw new MembaseApiError(projectInput.error, 400);
    }
    return this.request(`/wiki/documents/${args.doc_id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: args.title,
        content: args.content,
        collection_id: projectInput.value === null ? null : void 0,
        project: projectInput.value !== void 0 && projectInput.value !== null ? projectInput.value : void 0
      })
    });
  }
  async getKnownWikiProjects() {
    return this.request("/wiki/collections/known");
  }
  async deleteWiki(docId) {
    await this.request(`/wiki/documents/${docId}`, { method: "DELETE" });
  }
  async registerConnection() {
    await this.request("/agents/connect", {
      method: "POST",
      body: JSON.stringify({ source: MEMORY_SOURCE })
    });
  }
  async recordUsage() {
    await this.request("/agents/usage", {
      method: "POST",
      body: JSON.stringify({ source: MEMORY_SOURCE })
    });
  }
};
function createClient(apiUrl, tokens, onTokenRefresh, options) {
  return new MembaseClient({
    apiUrl,
    tokens,
    onTokenRefresh,
    timeoutMs: options?.timeoutMs
  });
}

// src/auth/oauth.ts
var import_node_crypto = require("node:crypto");
var import_node_http = require("node:http");
var import_node_child_process = require("node:child_process");
var CALLBACK_TIMEOUT_MS = 5 * 60 * 1e3;
function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function spawnDetached(command, args) {
  const child = (0, import_node_child_process.spawn)(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => void 0);
  child.unref();
}
function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url]
    };
  }
  return { command: "xdg-open", args: [url] };
}
function openBrowser(url) {
  try {
    const launch = browserLaunchCommand(url);
    spawnDetached(launch.command, launch.args);
  } catch {
  }
}
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}
async function registerClient(apiUrl, redirectUri) {
  const response = await fetch(`${apiUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    },
    body: JSON.stringify({
      client_name: "Membase Claude Code Plugin",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!response.ok) {
    throw new Error(`OAuth client registration failed: ${response.status}`);
  }
  return await response.json();
}
function listenForCallback() {
  return new Promise((resolve2, reject) => {
    const server = (0, import_node_http.createServer)((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found.");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? void 0;
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing OAuth code.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>Membase connected</h1><p>You can return to Claude Code.</p></body></html>"
        );
        server.emit("membase-code", { code, state });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(String(error));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate OAuth callback port"));
        return;
      }
      const codePromise = new Promise(
        (res) => {
          server.once(
            "membase-code",
            (payload) => res(payload)
          );
        }
      );
      resolve2({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        codePromise,
        close: () => {
          try {
            server.close();
          } catch {
          }
        }
      });
    });
  });
}
async function loginWithOAuth(apiUrl) {
  const callback = await listenForCallback();
  try {
    const verifier = base64Url((0, import_node_crypto.randomBytes)(32));
    const challenge = base64Url((0, import_node_crypto.createHash)("sha256").update(verifier).digest());
    const state = base64Url((0, import_node_crypto.randomBytes)(16));
    const client = await registerClient(apiUrl, callback.redirectUri);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: callback.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      mcp_source: "claude-code"
    });
    const authorizeUrl = `${apiUrl}/oauth/authorize?${params.toString()}`;
    openBrowser(authorizeUrl);
    console.error(`If the browser did not open, visit:
${authorizeUrl}`);
    const { code, state: returnedState } = await withTimeout(
      callback.codePromise,
      CALLBACK_TIMEOUT_MS,
      "OAuth login timed out before the browser callback completed."
    );
    if (returnedState !== state) {
      throw new Error("OAuth state mismatch");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callback.redirectUri,
      client_id: client.client_id,
      code_verifier: verifier
    });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    const response = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body,
      signal: AbortSignal.timeout(3e4)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OAuth token exchange failed: ${response.status} ${text}`
      );
    }
    const data = await response.json();
    return {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Math.floor(Date.now() / 1e3) + data.expires_in : void 0,
      scope: data.scope
    };
  } finally {
    callback.close();
  }
}

// src/config/index.ts
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function getDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", "plugins", "membase");
}
function ensureDataDir() {
  const dir = getDataDir();
  (0, import_node_fs.mkdirSync)(dir, { recursive: true, mode: 448 });
  try {
    (0, import_node_fs.chmodSync)(dir, 448);
  } catch {
  }
  return dir;
}
function configPath() {
  return (0, import_node_path.join)(ensureDataDir(), "config.json");
}
function credentialsPath() {
  return (0, import_node_path.join)(ensureDataDir(), "credentials.json");
}
function readJsonObject(path) {
  try {
    return JSON.parse((0, import_node_fs.readFileSync)(path, "utf-8"));
  } catch {
    return {};
  }
}
function writeJsonAtomic(path, value, mode = 384) {
  (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(path), { recursive: true, mode: 448 });
  const tmp = `${path}.tmp`;
  (0, import_node_fs.writeFileSync)(tmp, `${JSON.stringify(value, null, 2)}
`, {
    encoding: "utf-8",
    mode
  });
  (0, import_node_fs.renameSync)(tmp, path);
  try {
    (0, import_node_fs.chmodSync)(path, mode);
  } catch {
  }
}
function pluginOption(name) {
  return process.env[`CLAUDE_PLUGIN_OPTION_${name}`] ?? process.env[`CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}`];
}
function boolFromOption(name, fallback) {
  const value = pluginOption(name);
  if (value === void 0) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
function strFromOption(name) {
  const value = pluginOption(name);
  return value?.trim() ? value.trim() : void 0;
}
function numberFromOption(name) {
  const value = pluginOption(name);
  if (!value) return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function normalizeCaptureMode(value) {
  if (value === "wiki" || value === "summary") return "wiki";
  return "off";
}
function normalizeProjectMode(value) {
  if (value === "manual" || value === "off") return value;
  return "auto_git";
}
function normalizeSessionStartContext(value) {
  if (value === "off" || value === "profile") return value;
  return "minimal";
}
function clampRecallChars(value) {
  const raw = typeof value === "number" ? value : DEFAULT_MAX_RECALL_CHARS;
  return Math.max(MIN_RECALL_CHARS, Math.min(MAX_RECALL_CHARS, raw));
}
function loadConfig() {
  const disk = readJsonObject(configPath());
  const apiUrl = strFromOption("apiUrl") || (typeof disk.apiUrl === "string" ? disk.apiUrl : "") || DEFAULT_API_URL;
  const maxRecallChars = numberFromOption("maxRecallChars") ?? (typeof disk.maxRecallChars === "number" ? disk.maxRecallChars : DEFAULT_MAX_RECALL_CHARS);
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    autoRecall: boolFromOption(
      "autoRecall",
      typeof disk.autoRecall === "boolean" ? disk.autoRecall : true
    ),
    autoWikiRecall: boolFromOption(
      "autoWikiRecall",
      typeof disk.autoWikiRecall === "boolean" ? disk.autoWikiRecall : false
    ),
    captureMode: normalizeCaptureMode(disk.captureMode),
    maxRecallChars: clampRecallChars(maxRecallChars),
    sessionStartContext: normalizeSessionStartContext(
      strFromOption("sessionStartContext") ?? disk.sessionStartContext
    ),
    projectMode: normalizeProjectMode(
      strFromOption("projectMode") ?? disk.projectMode
    ),
    projectSlug: typeof disk.projectSlug === "string" && disk.projectSlug.trim() ? disk.projectSlug.trim() : void 0,
    debug: boolFromOption(
      "debug",
      typeof disk.debug === "boolean" ? disk.debug : false
    )
  };
}
function saveConfig(next) {
  const merged = { ...loadConfig(), ...next };
  writeJsonAtomic(configPath(), merged);
  return merged;
}
function readTokens() {
  const path = credentialsPath();
  if (!(0, import_node_fs.existsSync)(path)) return null;
  const obj = readJsonObject(path);
  if (typeof obj.clientId !== "string" || typeof obj.accessToken !== "string" || typeof obj.refreshToken !== "string") {
    return null;
  }
  return {
    clientId: obj.clientId,
    clientSecret: typeof obj.clientSecret === "string" ? obj.clientSecret : void 0,
    accessToken: obj.accessToken,
    refreshToken: obj.refreshToken,
    expiresAt: typeof obj.expiresAt === "number" ? obj.expiresAt : void 0,
    scope: typeof obj.scope === "string" ? obj.scope : void 0
  };
}
function writeTokens(tokens) {
  writeJsonAtomic(credentialsPath(), tokens);
}
function clearTokens() {
  try {
    (0, import_node_fs.rmSync)(credentialsPath(), { force: true });
  } catch {
  }
}

// src/sanitize/index.ts
var MEMBASE_CONTEXT_BLOCK_RE = /<membase-context>[\s\S]*?<\/membase-context>\s*/gi;
var PRIVATE_BLOCK_RE = /<(private|membase-private)>[\s\S]*?<\/\1>\s*/gi;
var METADATA_BLOCK_RE = /(sender|conversation info)\s*\(untrusted metadata\):\s*(?:```json[\s\S]*?```|json\s*\{[\s\S]*?\})/gi;
var SECRET_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[^\s`]+/gi;
var BEARER_TOKEN_RE = /\b(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
var CLI_SECRET_FLAG_RE = /((?:^|\s)--(?:api-key|apikey|token|secret|password|pat|key)(?:=|\s+))[^\s`]+/gi;
var COMMON_TOKEN_RE = /\b(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;
var PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
var SIMPLE_TAG_RE = /<\/?final>/gi;
function patternTest(pattern, text) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}
function sanitizeMembaseText(raw) {
  let cleaned = raw;
  cleaned = cleaned.replace(PRIVATE_BLOCK_RE, " ");
  cleaned = cleaned.replace(MEMBASE_CONTEXT_BLOCK_RE, " ");
  cleaned = cleaned.replace(METADATA_BLOCK_RE, " ");
  cleaned = cleaned.replace(PRIVATE_KEY_RE, "[REDACTED_PRIVATE_KEY]");
  cleaned = cleaned.replace(SECRET_ASSIGNMENT_RE, "$1=[REDACTED]");
  cleaned = cleaned.replace(BEARER_TOKEN_RE, "$1[REDACTED]");
  cleaned = cleaned.replace(CLI_SECRET_FLAG_RE, "$1[REDACTED]");
  cleaned = cleaned.replace(COMMON_TOKEN_RE, "[REDACTED_TOKEN]");
  cleaned = cleaned.replace(SIMPLE_TAG_RE, " ");
  return cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n").trim();
}
function looksSensitive(text) {
  return patternTest(SECRET_ASSIGNMENT_RE, text) || patternTest(BEARER_TOKEN_RE, text) || patternTest(CLI_SECRET_FLAG_RE, text) || patternTest(COMMON_TOKEN_RE, text) || patternTest(PRIVATE_KEY_RE, text) || /\.env(\.|$|\s)/i.test(text);
}
function truncateText(value, max = 500) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

// src/format/index.ts
function formatBundle(bundle, index) {
  const episode = bundle.episode;
  const score = typeof bundle.relevance_score === "number" ? ` score=${bundle.relevance_score.toFixed(3)}` : "";
  const source = episode.source ? ` source=${episode.source}` : "";
  const when = episode.valid_at || episode.created_at || "";
  const facts = (bundle.edges ?? []).map((edge) => edge.fact).filter((fact) => Boolean(fact)).slice(0, 3).map((fact) => `    - ${truncateText(fact, 180)}`).join("\n");
  const header = `${index + 1}. ${truncateText(episode.name || episode.summary || "Memory", 180)}${score}${source}${when ? ` at=${when}` : ""}`;
  const summary = episode.summary ? `   summary: ${truncateText(episode.summary, 240)}` : "";
  return [header, summary, facts ? `   related facts:
${facts}` : ""].filter(Boolean).join("\n");
}
function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}
function normalizeProjectName(value) {
  return value?.trim() ?? "";
}
function formatSearchProjectName(collectionId, collectionName) {
  return normalizeProjectName(collectionName) || (collectionId ? "Unknown" : "Basic");
}
function appendResultSentence(base, sentence) {
  return sentence ? `${base}. ${sentence}` : base;
}
function formatSavedDestination(routing, collectionId, explicitProject) {
  if (routing?.fallback) {
    return "Saved to Basic because no confident Project was found.";
  }
  const routedProjectName = normalizeProjectName(routing?.collection_name);
  if (routedProjectName) {
    return `Saved to Project: ${routedProjectName}.`;
  }
  const explicitProjectName = normalizeProjectName(explicitProject);
  if (explicitProjectName && collectionId) {
    return `Saved to Project: ${explicitProjectName}.`;
  }
  if (!collectionId) {
    return "Saved to Basic.";
  }
  return void 0;
}
function formatWikiCreateResult(doc, explicitProject) {
  return appendResultSentence(
    `Wiki document created: "${doc.title}" (ID: ${doc.id})`,
    formatSavedDestination(doc.routing, doc.collection_id, explicitProject)
  );
}
function formatSourceName(source) {
  if (!source) return "Source";
  return source.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function formatSourceReference(ref) {
  const label = formatSourceName(ref.source);
  const title = ref.title?.trim();
  const base = ref.url ? `${title ? `${label} - ${title}` : label} (${ref.url})` : title ? `${label} - ${title}` : label;
  if (ref.status && ref.status !== "active") {
    return ref.warning ? `${base} [${ref.status}: ${ref.warning}]` : `${base} [${ref.status}]`;
  }
  return base;
}
var SOURCE_REFERENCE_PRIORITY = {
  primary: 0,
  updated: 1,
  supporting: 2,
  derived: 3
};
function formatSourceReferences(refs) {
  const sortedRefs = [...refs ?? []].filter((ref) => ref?.source).sort(
    (a, b) => (SOURCE_REFERENCE_PRIORITY[a.link_type] ?? 99) - (SOURCE_REFERENCE_PRIORITY[b.link_type] ?? 99)
  );
  const primary = sortedRefs[0];
  if (!primary) return "";
  const extraCount = sortedRefs.length - 1;
  const suffix = extraCount > 0 ? `; +${extraCount} additional reference${extraCount === 1 ? "" : "s"}` : "";
  return `Source: ${formatSourceReference(primary)}${suffix}`;
}
function formatWikiDocumentDetails(doc) {
  const parts = [];
  const sourceReferences = formatSourceReferences(doc.source_references);
  if (sourceReferences) {
    parts.push(sourceReferences);
  } else if (doc.source) {
    parts.push(`source: ${doc.source}`);
  }
  if (doc.source_status && doc.source_status !== "active") {
    parts.push(`source_status: ${doc.source_status}`);
  }
  if (doc.source_warning) {
    parts.push(`source_warning: ${doc.source_warning}`);
  }
  const sourceChecked = formatDate(doc.source_last_checked_at);
  if (sourceChecked && doc.source_status && doc.source_status !== "active") {
    parts.push(`source_checked: ${sourceChecked}`);
  }
  const created = formatDate(doc.created_at);
  if (created) parts.push(`created: ${created}`);
  const updated = formatDate(doc.updated_at);
  if (updated) parts.push(`updated: ${updated}`);
  return parts.join("; ");
}
function formatWikiDocument(doc, index) {
  const similarity = typeof doc.similarity === "number" ? ` [similarity: ${doc.similarity.toFixed(3)}]` : "";
  const project = ` [Project: ${formatSearchProjectName(
    doc.collection_id,
    doc.collection_name
  )}]`;
  const details = formatWikiDocumentDetails(doc);
  return [
    `${index + 1}. ${truncateText(doc.title, 180)}${project}${similarity}`,
    `   id: ${doc.id}`,
    details ? `   ${details}` : "",
    `   ${truncateText(doc.content, 700)}`
  ].filter(Boolean).join("\n");
}

// src/project/index.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
function normalizeProjectSlug(raw) {
  return raw.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}-]+/gu, "-").replace(/_{1,}/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
function findGitRoot(cwd) {
  let current = cwd;
  while (current && current !== (0, import_node_path2.parse)(current).root) {
    if ((0, import_node_fs2.existsSync)((0, import_node_path2.join)(current, ".git"))) return current;
    current = (0, import_node_path2.dirname)(current);
  }
  return null;
}
function remoteSlug(gitRoot) {
  try {
    const gitConfig = (0, import_node_fs2.readFileSync)((0, import_node_path2.join)(gitRoot, ".git", "config"), "utf-8");
    const match = gitConfig.match(/url\s*=\s*(.+)\n/);
    if (!match?.[1]) return null;
    const value = match[1].trim().replace(/^git@[^:]+:/, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
    return normalizeProjectSlug(value);
  } catch {
    return null;
  }
}
function resolveProjectSlug(cwd, config) {
  if (config.projectMode === "off") return void 0;
  if (config.projectSlug) return normalizeProjectSlug(config.projectSlug);
  if (config.projectMode === "manual") return void 0;
  if (!cwd) return void 0;
  const gitRoot = findGitRoot(cwd);
  if (gitRoot)
    return remoteSlug(gitRoot) || normalizeProjectSlug((0, import_node_path2.basename)(gitRoot));
  return normalizeProjectSlug((0, import_node_path2.basename)(cwd));
}

// src/spool/index.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var LOCK_STALE_MS = 3e4;
var LOCK_WAIT_MS = 2e3;
var INFLIGHT_STALE_MS = 6e4;
var MAX_WIKI_CAPTURE_CHARS = 95e3;
var SLEEP_BUFFER = new SharedArrayBuffer(4);
var SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);
function spoolDir() {
  const dir = (0, import_node_path3.join)(ensureDataDir(), "spool");
  (0, import_node_fs3.mkdirSync)(dir, { recursive: true, mode: 448 });
  return dir;
}
function spoolPath() {
  return (0, import_node_path3.join)(spoolDir(), "pending.jsonl");
}
function sentPath() {
  return (0, import_node_path3.join)(spoolDir(), "sent.json");
}
function lockPath() {
  return (0, import_node_path3.join)(spoolDir(), ".lock");
}
function inflightPath() {
  return (0, import_node_path3.join)(spoolDir(), `inflight-${process.pid}-${Date.now()}.jsonl`);
}
function sleepSync(ms) {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}
function acquireLock(timeoutMs = LOCK_WAIT_MS) {
  const path = lockPath();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const fd = (0, import_node_fs3.openSync)(path, "wx", 384);
      (0, import_node_fs3.writeFileSync)(fd, `${process.pid}
${Date.now()}
`);
      return () => {
        try {
          (0, import_node_fs3.closeSync)(fd);
        } catch {
        }
        try {
          (0, import_node_fs3.rmSync)(path, { force: true });
        } catch {
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - (0, import_node_fs3.statSync)(path).mtimeMs > LOCK_STALE_MS) {
          (0, import_node_fs3.rmSync)(path, { force: true });
          continue;
        }
      } catch {
      }
      sleepSync(25);
    }
  }
  throw new Error("Timed out waiting for Membase capture spool lock.");
}
function withSpoolLock(callback, timeoutMs = LOCK_WAIT_MS) {
  const release = acquireLock(timeoutMs);
  try {
    return callback();
  } finally {
    release();
  }
}
function splitContent(content) {
  if (content.length <= MAX_WIKI_CAPTURE_CHARS) return [content];
  const chunks = [];
  let current = [];
  let currentSize = 0;
  const pushCurrent = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n").trim());
    current = [];
    currentSize = 0;
  };
  for (const block of content.split("\n\n")) {
    if (block.length > MAX_WIKI_CAPTURE_CHARS) {
      let remainder = block;
      if (current.length > 0) {
        const remainingSpace = MAX_WIKI_CAPTURE_CHARS - currentSize - 2;
        const prefix = remainingSpace > 0 ? block.slice(0, remainingSpace) : "";
        if (prefix) {
          current.push(prefix);
          remainder = block.slice(prefix.length);
        }
        pushCurrent();
      }
      for (let start = 0; start < remainder.length; start += MAX_WIKI_CAPTURE_CHARS) {
        chunks.push(remainder.slice(start, start + MAX_WIKI_CAPTURE_CHARS));
      }
    } else if (current.length > 0 && currentSize + 2 + block.length > MAX_WIKI_CAPTURE_CHARS) {
      pushCurrent();
      current = [block];
      currentSize = block.length;
    } else {
      if (current.length > 0) {
        currentSize += 2;
      }
      current.push(block);
      currentSize += block.length;
    }
  }
  pushCurrent();
  return chunks.filter(Boolean);
}
function readRecordsFromPath(path) {
  if (!(0, import_node_fs3.existsSync)(path)) return [];
  const raw = (0, import_node_fs3.readFileSync)(path, "utf-8").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((record) => Boolean(record));
}
function readRecords() {
  return readRecordsFromPath(spoolPath());
}
function writeRecordsToPath(path, records) {
  const tmp = `${path}.tmp`;
  (0, import_node_fs3.writeFileSync)(
    tmp,
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
    { encoding: "utf-8", mode: 384 }
  );
  (0, import_node_fs3.renameSync)(tmp, path);
}
function writeRecords(records) {
  writeRecordsToPath(spoolPath(), records);
}
function appendRecords(records) {
  if (records.length === 0) return;
  (0, import_node_fs3.appendFileSync)(
    spoolPath(),
    `${records.map((record) => JSON.stringify(record)).join("\n")}
`,
    {
      encoding: "utf-8",
      mode: 384
    }
  );
}
function readSentIds() {
  const path = sentPath();
  if (!(0, import_node_fs3.existsSync)(path)) return /* @__PURE__ */ new Set();
  try {
    const parsed = JSON.parse((0, import_node_fs3.readFileSync)(path, "utf-8"));
    if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
    return new Set(
      parsed.filter((value) => typeof value === "string")
    );
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function writeSentIds(ids) {
  const values = Array.from(ids).slice(-2e3);
  const path = sentPath();
  const tmp = `${path}.tmp`;
  (0, import_node_fs3.writeFileSync)(tmp, `${JSON.stringify(values, null, 2)}
`, {
    encoding: "utf-8",
    mode: 384
  });
  (0, import_node_fs3.renameSync)(tmp, path);
}
function inflightFiles() {
  return (0, import_node_fs3.readdirSync)(spoolDir()).filter((name) => name.startsWith("inflight-") && name.endsWith(".jsonl")).map((name) => (0, import_node_path3.join)(spoolDir(), name));
}
function dedupeRecords(records, sentIds = readSentIds()) {
  const seen = /* @__PURE__ */ new Set();
  return records.filter((record) => {
    if (sentIds.has(record.capture_id) || seen.has(record.capture_id)) {
      return false;
    }
    seen.add(record.capture_id);
    return true;
  });
}
function appendPendingRecordsLocked(records) {
  const sentIds = readSentIds();
  const existingIds = new Set(readRecords().map((record) => record.capture_id));
  const next = records.filter((record) => {
    if (sentIds.has(record.capture_id) || existingIds.has(record.capture_id)) {
      return false;
    }
    existingIds.add(record.capture_id);
    return true;
  });
  appendRecords(next);
}
function recoverStaleInflightLocked() {
  const now = Date.now();
  for (const path of inflightFiles()) {
    try {
      if (now - (0, import_node_fs3.statSync)(path).mtimeMs < INFLIGHT_STALE_MS) continue;
      appendPendingRecordsLocked(readRecordsFromPath(path));
      (0, import_node_fs3.rmSync)(path, { force: true });
    } catch {
    }
  }
}
async function flushSpool(client, limit = 10) {
  const drained = withSpoolLock(() => {
    recoverStaleInflightLocked();
    const sentIds = readSentIds();
    const records = dedupeRecords(readRecords(), sentIds);
    const batch = records.slice(0, limit);
    const pending = records.slice(limit);
    writeRecords(pending);
    const path = batch.length > 0 ? inflightPath() : void 0;
    if (path) writeRecordsToPath(path, batch);
    return { batch, path };
  });
  if (drained.batch.length === 0) {
    return { flushed: 0, remaining: pendingSpoolCount() };
  }
  const failed = [];
  let flushed = 0;
  for (const record of drained.batch) {
    let sentPartCount = Math.max(0, record.sent_part_count ?? 0);
    try {
      const chunks = splitContent(record.content);
      sentPartCount = Math.min(sentPartCount, chunks.length);
      for (const [index, content] of chunks.entries()) {
        if (index < sentPartCount) continue;
        const multiPart = chunks.length > 1;
        await client.addWiki({
          title: (record.title ?? "Claude Code conversation capture") + (multiPart ? ` part ${index + 1}` : ""),
          content,
          project: record.project,
          source_metadata: {
            ...record.metadata,
            capture_kind: record.capture_kind,
            part_index: index + 1,
            part_total: chunks.length
          }
        });
        sentPartCount = index + 1;
      }
      withSpoolLock(() => {
        const sentIds = readSentIds();
        sentIds.add(record.capture_id);
        writeSentIds(sentIds);
      });
      flushed += 1;
    } catch (error) {
      failed.push({
        ...record,
        attempts: (record.attempts ?? 0) + 1,
        sent_part_count: sentPartCount,
        last_error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const remaining = withSpoolLock(() => {
    appendPendingRecordsLocked(failed);
    if (drained.path) (0, import_node_fs3.rmSync)(drained.path, { force: true });
    return readRecords().length;
  });
  return { flushed, remaining };
}
function pendingSpoolCount() {
  return withSpoolLock(() => {
    recoverStaleInflightLocked();
    return readRecords().length;
  });
}

// src/cli.ts
async function askCaptureConsent() {
  const rl = (0, import_promises.createInterface)({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "Enable Wiki auto-capture for user/assistant transcripts? [Y/n] "
    );
    return /^n/i.test(answer.trim()) ? "off" : "wiki";
  } finally {
    rl.close();
  }
}
function printUsage() {
  console.log(`Membase Claude Code Plugin ${PLUGIN_VERSION}

Usage:
  membase login
  membase logout
  membase status
  membase recall <query>
  membase remember <text>
  membase wiki search [--project <project>] <query>
  membase wiki add [--project <project>] <title> -- <markdown>
  membase index-project <summary>
  membase project-config <slug|off|auto>
`);
}
function duplicateMcpConfigs() {
  const candidates = [
    (0, import_node_path4.join)((0, import_node_os2.homedir)(), ".claude.json"),
    (0, import_node_path4.join)(process.cwd(), ".mcp.json")
  ];
  const matches = [];
  for (const path of candidates) {
    if (!(0, import_node_fs4.existsSync)(path)) continue;
    try {
      const raw = (0, import_node_fs4.readFileSync)(path, "utf-8");
      const lower = raw.toLowerCase();
      const hasMembaseRemoteUrl = lower.includes(DEFAULT_MCP_URL);
      const hasLegacyMembaseRemote = lower.includes("membase") && lower.includes("mcp-remote");
      if (hasMembaseRemoteUrl || hasLegacyMembaseRemote) {
        matches.push(path);
      }
    } catch {
    }
  }
  return matches;
}
async function authedClient() {
  const config = loadConfig();
  const tokens = readTokens();
  if (!tokens) {
    throw new Error("Not logged in. Run /membase:login first.");
  }
  return {
    config,
    client: createClient(config.apiUrl, tokens, writeTokens)
  };
}
async function commandLogin() {
  const config = loadConfig();
  console.log(`Opening Membase OAuth login (${config.apiUrl})...`);
  const tokens = await loginWithOAuth(config.apiUrl);
  writeTokens(tokens);
  const captureMode = await askCaptureConsent();
  saveConfig({ captureMode });
  const client = createClient(config.apiUrl, tokens, writeTokens);
  await client.registerConnection().catch(() => void 0);
  console.log("Membase connected.");
  console.log(`Auto-capture: ${captureMode}`);
}
async function commandStatus() {
  const config = loadConfig();
  const tokens = readTokens();
  let pendingCaptures = pendingSpoolCount();
  let flushedCaptures = 0;
  if (tokens) {
    const client = createClient(config.apiUrl, tokens, writeTokens);
    const result = await flushSpool(client, 20).catch(() => ({
      flushed: 0,
      remaining: pendingSpoolCount()
    }));
    flushedCaptures = result.flushed;
    pendingCaptures = result.remaining;
    await client.recordUsage().catch(() => void 0);
  }
  console.log(`Membase Claude Code Plugin ${PLUGIN_VERSION}`);
  console.log(`API: ${config.apiUrl}`);
  console.log(`Logged in: ${tokens ? "yes" : "no"}`);
  console.log(`Auto-recall: ${config.autoRecall}`);
  console.log(`Auto-wiki-recall: ${config.autoWikiRecall}`);
  console.log(`Auto-capture: ${config.captureMode}`);
  console.log(`Session-start context: ${config.sessionStartContext}`);
  console.log(`Pending capture spool: ${pendingCaptures}`);
  if (flushedCaptures > 0) {
    console.log(`Flushed pending captures: ${flushedCaptures}`);
  }
  console.log(
    `Project: ${resolveProjectSlug(process.cwd(), config) ?? "(none)"}`
  );
  const duplicates = duplicateMcpConfigs();
  if (duplicates.length > 0) {
    console.log("");
    console.log("Potential existing remote Membase MCP config detected:");
    for (const path of duplicates) console.log(`  - ${path}`);
    console.log(
      "Remove duplicate remote MCP configs if you see duplicate Membase tools in Claude Code."
    );
  }
}
async function commandRecall(query) {
  const { config, client } = await authedClient();
  const project = resolveProjectSlug(process.cwd(), config);
  const [memories, wiki] = await Promise.all([
    client.searchMemory({ query, limit: 10, project }),
    config.autoWikiRecall ? client.searchWiki({ query, limit: 5 }) : Promise.resolve([])
  ]);
  if (memories.length === 0 && wiki.length === 0) {
    console.log("No Membase context found.");
    return;
  }
  for (const [index, memory] of memories.entries()) {
    console.log(formatBundle(memory, index));
    console.log("");
  }
  for (const [index, doc] of wiki.entries()) {
    console.log(formatWikiDocument(doc, index));
    console.log("");
  }
}
async function storeMemory(text, captureKind) {
  const { config, client } = await authedClient();
  const project = resolveProjectSlug(process.cwd(), config);
  if (looksSensitive(text)) {
    throw new Error("Refusing to store content that looks like a secret.");
  }
  const content = sanitizeMembaseText(text);
  await client.ingestMemory({
    content,
    display_summary: truncateText(content, 180),
    project,
    metadata: {
      plugin: "claude-membase",
      plugin_version: PLUGIN_VERSION,
      capture_kind: captureKind,
      project_slug: project ?? null
    }
  });
  console.log("Stored in Membase.");
}
async function commandRemember(text) {
  await storeMemory(text, "explicit");
}
async function commandIndexProject(text) {
  await storeMemory(text, "project_index");
}
async function commandWiki(args) {
  const { config, client } = await authedClient();
  const action = args[0];
  const projectFlagIndex = args.indexOf("--project");
  const project = projectFlagIndex >= 0 ? args[projectFlagIndex + 1] : void 0;
  const rest = projectFlagIndex >= 0 ? args.filter(
    (_, index) => index !== projectFlagIndex && index !== projectFlagIndex + 1
  ) : args;
  if (action === "search") {
    const query = rest.slice(1).join(" ");
    const docs = await client.searchWiki({ query, limit: 10, project });
    for (const [index, doc] of docs.entries()) {
      console.log(formatWikiDocument(doc, index));
      console.log("");
    }
    return;
  }
  if (action === "add") {
    const separator = rest.indexOf("--");
    const title = separator > 1 ? rest.slice(1, separator).join(" ") : rest[1];
    const content = separator > 1 ? rest.slice(separator + 1).join(" ") : rest.slice(2).join(" ");
    if (!title || !content)
      throw new Error("Usage: membase wiki add <title> -- <markdown>");
    if (looksSensitive(content)) {
      throw new Error(
        "Refusing to store wiki content that looks like a secret."
      );
    }
    const doc = await client.addWiki({
      title,
      content,
      project,
      source_metadata: {
        project_slug: resolveProjectSlug(process.cwd(), config) ?? null
      }
    });
    console.log(formatWikiCreateResult(doc, project));
    return;
  }
  throw new Error(
    "Usage: membase wiki search [--project <project>] <query> | membase wiki add [--project <project>] <title> -- <markdown>"
  );
}
function commandProjectConfig(value) {
  if (!value) {
    console.log(
      `Current project: ${resolveProjectSlug(process.cwd(), loadConfig()) ?? "(none)"}`
    );
    return;
  }
  if (value === "off") {
    saveConfig({ projectMode: "off", projectSlug: void 0 });
  } else if (value === "auto") {
    saveConfig({ projectMode: "auto_git", projectSlug: void 0 });
  } else {
    saveConfig({ projectMode: "manual", projectSlug: value });
  }
  console.log(
    `Project config updated: ${resolveProjectSlug(process.cwd(), loadConfig()) ?? "(none)"}`
  );
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }
  if (command === "login") return commandLogin();
  if (command === "logout") {
    clearTokens();
    saveConfig({ captureMode: "off" });
    console.log("Logged out of Membase.");
    return;
  }
  if (command === "status") return commandStatus();
  if (command === "recall") return commandRecall(args.join(" "));
  if (command === "remember") return commandRemember(args.join(" "));
  if (command === "wiki") return commandWiki(args);
  if (command === "index-project") return commandIndexProject(args.join(" "));
  if (command === "project-config") return commandProjectConfig(args[0]);
  printUsage();
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
