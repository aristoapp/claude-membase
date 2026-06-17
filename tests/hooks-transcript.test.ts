import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  markTranscriptCaptured,
  readTranscriptCapture,
} from "../src/hooks/transcript.js";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  delete process.env.CLAUDE_PLUGIN_DATA;
});

function writeTranscript(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("transcript capture", () => {
  it("captures user and assistant messages while skipping tool payloads", () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-transcript-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const transcriptPath = join(tempDir, "session.jsonl");
    writeTranscript(transcriptPath, [
      {
        type: "user",
        message: { role: "user", content: "Please update the wiki capture." },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will save the original transcript." },
            { type: "tool_use", name: "Bash" },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "hidden terminal output" }],
        },
      },
    ]);

    const result = readTranscriptCapture(
      {
        session_id: "session-1",
        transcript_path: transcriptPath,
      },
      "Membase",
    );

    expect(result?.lineCount).toBe(3);
    expect(result?.capture?.capture_kind).toBe("conversation_transcript");
    expect(result?.capture?.project).toBe("Membase");
    expect(result?.capture?.content).toContain("### User");
    expect(result?.capture?.content).toContain(
      "Please update the wiki capture.",
    );
    expect(result?.capture?.content).toContain("### Assistant");
    expect(result?.capture?.content).toContain(
      "I will save the original transcript.",
    );
    expect(result?.capture?.content).not.toContain("Session:");
    expect(result?.capture?.content).not.toContain("Transcript:");
    expect(result?.capture?.content).not.toContain("hidden terminal output");
    expect(result?.capture?.metadata).not.toHaveProperty("claude_session_id");
    expect(result?.capture?.metadata).not.toHaveProperty("transcript_hash");
    expect(result?.capture?.metadata).not.toHaveProperty("transcript_name");
  });

  it("uses the cursor to read only new transcript lines", () => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-membase-transcript-"));
    process.env.CLAUDE_PLUGIN_DATA = tempDir;
    const transcriptPath = join(tempDir, "session.jsonl");
    writeTranscript(transcriptPath, [
      { type: "user", message: { role: "user", content: "First prompt" } },
    ]);

    const input = { session_id: "session-1", transcript_path: transcriptPath };
    markTranscriptCaptured(input, 1);
    writeTranscript(transcriptPath, [
      { type: "user", message: { role: "user", content: "First prompt" } },
      {
        type: "assistant",
        message: { role: "assistant", content: "Second answer" },
      },
    ]);

    const result = readTranscriptCapture(input);
    expect(result?.capture?.content).not.toContain("First prompt");
    expect(result?.capture?.content).toContain("Second answer");
  });
});
