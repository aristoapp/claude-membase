import { afterEach, describe, expect, it } from "bun:test";
import { MembaseClient } from "../src/api/client.js";
import { DEFAULT_API_TIMEOUT_MS } from "../src/constants.js";
import {
  formatWikiCreateResult,
  formatWikiDocument,
  formatWikiUpdateResult,
} from "../src/format/index.js";

const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: originalAbortSignalTimeout,
  });
});

function makeClient(): MembaseClient {
  return new MembaseClient({
    apiUrl: "https://api.test",
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      clientId: "client-id",
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}

describe("wiki client payloads", () => {
  it("uses the default API timeout for requests without an override", async () => {
    const timeouts: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (timeoutMs: number) => {
        timeouts.push(timeoutMs);
        return new AbortController().signal;
      },
    });
    mockFetch(() =>
      jsonResponse({
        id: "doc-1",
        title: "Title",
        content: "Body",
      }),
    );

    await makeClient().addWiki({
      title: "Title",
      content: "Body",
      project: "Docs",
    });

    expect(timeouts).toEqual([DEFAULT_API_TIMEOUT_MS]);
  });

  it("sends project and source metadata when adding wiki documents", async () => {
    let requestBody: Record<string, unknown> | undefined;
    mockFetch((_url, init) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "doc-1",
        title: "Title",
        content: "Body",
      });
    });

    await makeClient().addWiki({
      title: "Title",
      content: "Body",
      project: "Docs",
      source_metadata: {
        client_context: "unit-test",
        plugin_name: "spoofed",
        host: "spoofed",
      },
    });

    expect(requestBody).toMatchObject({
      title: "Title",
      content: "Body",
      source: "claude-code",
      project: "Docs",
      source_metadata: {
        plugin_name: "claude-membase",
        plugin_version: "0.2.0",
        host: "claude-code",
        client_context: "unit-test",
      },
    });
    expect(requestBody).not.toHaveProperty("summarize");
    expect(requestBody).not.toHaveProperty("collection");
  });

  it("normalizes legacy collection aliases to project", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return jsonResponse({ documents: [] });
    });

    await makeClient().searchWiki({
      query: "migration",
      limit: 5,
      collection: "Legacy Docs",
    });

    expect(urls[0]).toContain("project=Legacy+Docs");
    expect(urls[0]).not.toContain("collection=");
  });

  it("sends collection_id null when clearing a wiki project", async () => {
    let requestBody: Record<string, unknown> | undefined;
    mockFetch((_url, init) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "doc-1",
        title: "Title",
        content: "Body",
      });
    });

    await makeClient().updateWiki({
      doc_id: "doc-1",
      project: null,
    });

    expect(requestBody).toEqual({ collection_id: null });
  });
});

describe("wiki formatting", () => {
  it("shows source references and source warnings", () => {
    const text = formatWikiDocument(
      {
        id: "doc-1",
        title: "Runbook",
        content: "Body",
        source: "notion",
        collection_id: "project-1",
        collection_name: "Ops",
        similarity: 0.81,
        source_status: "inaccessible",
        source_warning: "Source page is no longer accessible.",
        source_last_checked_at: "2026-05-18T00:00:00Z",
        source_references: [
          {
            source: "notion",
            title: "Ops Runbook",
            url: "https://notion.so/runbook",
            status: "active",
            link_type: "primary",
          },
          {
            source: "upload",
            title: "Import",
            status: "active",
            link_type: "supporting",
          },
        ],
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-02T00:00:00Z",
      },
      0,
    );

    expect(text).toContain("[Project: Ops]");
    expect(text).toContain("[similarity: 0.810]");
    expect(text).toContain(
      "Source: Notion - Ops Runbook (https://notion.so/runbook); +1 additional reference",
    );
    expect(text).toContain("source_status: inaccessible");
    expect(text).toContain(
      "source_warning: Source page is no longer accessible.",
    );
    expect(text).toContain("created: 2026-05-01");
    expect(text).toContain("updated: 2026-05-02");
  });

  it("labels Basic and Unknown project locations", () => {
    const basic = formatWikiDocument(
      {
        id: "doc-basic",
        title: "Basic Doc",
        content: "Body",
        collection_id: null,
        collection_name: null,
      },
      0,
    );
    const unknown = formatWikiDocument(
      {
        id: "doc-unknown",
        title: "Unknown Doc",
        content: "Body",
        collection_id: "project-1",
        collection_name: null,
      },
      1,
    );

    expect(basic).toContain("[Project: Basic]");
    expect(unknown).toContain("[Project: Unknown]");
  });

  it("formats create and update destinations", () => {
    expect(
      formatWikiCreateResult(
        {
          id: "doc-1",
          title: "Routing",
          content: "Body",
          collection_id: "project-1",
          collection_name: "Wiki Improvements",
          routing: {
            collection_id: "project-1",
            collection_name: "Wiki Improvements",
            routing_source: "auto_route",
            confidence: 0.9,
          },
        },
        undefined,
      ),
    ).toBe(
      'Wiki document created: "Routing" (ID: doc-1). Saved to Project: Wiki Improvements.',
    );
    expect(
      formatWikiCreateResult(
        {
          id: "doc-2",
          title: "Fallback",
          content: "Body",
          collection_id: null,
          collection_name: null,
          routing: {
            fallback: true,
            routing_source: "fallback_uncategorized",
          },
        },
        undefined,
      ),
    ).toBe(
      'Wiki document created: "Fallback" (ID: doc-2). Saved to Basic because no confident Project was found.',
    );
    expect(
      formatWikiUpdateResult(
        {
          id: "doc-3",
          title: "Moved",
          content: "Body",
          collection_id: "project-2",
          collection_name: "Docs",
        },
        "Docs",
      ),
    ).toBe(
      'Wiki document updated: "Moved" (ID: doc-3). Moved to Project: Docs.',
    );
    expect(
      formatWikiUpdateResult(
        {
          id: "doc-4",
          title: "Cleared",
          content: "Body",
          collection_id: null,
          collection_name: null,
        },
        null,
      ),
    ).toBe('Wiki document updated: "Cleared" (ID: doc-4). Moved to Basic.');
  });
});
