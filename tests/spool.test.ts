import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  enqueueCapture,
  flushSpool,
  pendingSpoolCount,
} from "../src/spool/index.js";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  delete process.env.CLAUDE_PLUGIN_DATA;
});

describe("spool", () => {
  it("deduplicates capture ids", () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-test-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const record = {
      capture_kind: "conversation_transcript" as const,
      content: "The user prefers TypeScript for frontend work.",
      sessionId: "s1",
      metadata: { plugin: "claude-membase" },
    };
    expect(enqueueCapture(record)).not.toBeNull();
    expect(enqueueCapture(record)).toBeNull();
    expect(pendingSpoolCount()).toBe(1);
  });

  it("does not re-enqueue captures after a successful flush", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-test-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const record = {
      capture_kind: "conversation_transcript" as const,
      content: "The user decided to keep the plugin-local bridge architecture.",
      sessionId: "s1",
      metadata: { plugin: "claude-membase" },
    };
    const client = {
      addWiki: async () => ({ id: "doc-1" }),
    };

    expect(enqueueCapture(record)).not.toBeNull();
    await expect(flushSpool(client as never)).resolves.toEqual({
      flushed: 1,
      remaining: 0,
    });
    expect(enqueueCapture(record)).toBeNull();
    expect(pendingSpoolCount()).toBe(0);
  });

  it("preserves captures enqueued while a flush is in flight", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-test-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const first = {
      capture_kind: "conversation_transcript" as const,
      content: "The team chose local bridge hooks for Claude Code memory.",
      sessionId: "s1",
      metadata: { plugin: "claude-membase" },
    };
    const second = {
      capture_kind: "conversation_transcript" as const,
      content: "Claude Code ran the release verification command successfully.",
      sessionId: "s1",
      metadata: { plugin: "claude-membase" },
    };
    let enqueuedDuringFlush = false;
    const client = {
      addWiki: async () => {
        if (!enqueuedDuringFlush) {
          enqueuedDuringFlush = true;
          expect(enqueueCapture(second)).not.toBeNull();
        }
        return { id: "doc-1" };
      },
    };

    expect(enqueueCapture(first)).not.toBeNull();
    await expect(flushSpool(client as never, 1)).resolves.toEqual({
      flushed: 1,
      remaining: 1,
    });
    expect(pendingSpoolCount()).toBe(1);
    await expect(flushSpool(client as never, 10)).resolves.toEqual({
      flushed: 1,
      remaining: 0,
    });
  });

  it("splits large wiki captures into sequential documents", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-test-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const docs: Array<{
      title: string;
      content: string;
      project?: string;
      source_metadata?: Record<string, unknown>;
    }> = [];
    const record = {
      capture_kind: "conversation_transcript" as const,
      title: "Claude Code conversation capture",
      content: [
        "# Claude Code Conversation Capture",
        "",
        "## Transcript",
        "",
        `### User\n${"A".repeat(140_000)}`,
      ].join("\n"),
      sessionId: "s1",
      project: "Membase",
      metadata: { plugin: "claude-membase" },
    };
    const client = {
      addWiki: async (doc: (typeof docs)[number]) => {
        docs.push(doc);
        return { id: `doc-${docs.length}` };
      },
    };

    expect(enqueueCapture(record)).not.toBeNull();
    await expect(flushSpool(client as never)).resolves.toEqual({
      flushed: 1,
      remaining: 0,
    });

    expect(docs.length).toBeGreaterThan(1);
    expect(docs[0]?.content).toContain("A");
    for (const [index, doc] of docs.entries()) {
      expect(doc.title).toContain(`part ${index + 1}`);
      expect(doc.content.length).toBeLessThanOrEqual(95_000);
      expect(doc.project).toBe("Membase");
      expect(doc.source_metadata).toMatchObject({
        capture_kind: "conversation_transcript",
        part_index: index + 1,
        part_total: docs.length,
      });
    }
  });

  it("retries only unsaved Wiki parts after a partial flush failure", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-test-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const createdParts: number[] = [];
    let failSecondPart = true;
    const record = {
      capture_kind: "conversation_transcript" as const,
      title: "Claude Code conversation capture",
      content: [
        "# Claude Code Conversation Capture",
        "",
        "## Transcript",
        "",
        `### User\n${"A".repeat(140_000)}`,
      ].join("\n"),
      sessionId: "s1",
      metadata: { plugin: "claude-membase" },
    };
    const client = {
      addWiki: async (doc: { source_metadata?: Record<string, unknown> }) => {
        const partIndex = Number(doc.source_metadata?.part_index ?? 1);
        if (failSecondPart && partIndex === 2) {
          failSecondPart = false;
          throw new Error("temporary wiki outage");
        }
        createdParts.push(partIndex);
        return { id: `doc-${createdParts.length}` };
      },
    };

    expect(enqueueCapture(record)).not.toBeNull();
    await expect(flushSpool(client as never)).resolves.toEqual({
      flushed: 0,
      remaining: 1,
    });
    await expect(flushSpool(client as never)).resolves.toEqual({
      flushed: 1,
      remaining: 0,
    });

    expect(createdParts.filter((part) => part === 1)).toHaveLength(1);
    expect(createdParts).toContain(2);
  });
});
