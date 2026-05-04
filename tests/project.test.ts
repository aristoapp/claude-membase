import { describe, expect, it } from "bun:test";
import { normalizeProjectSlug } from "../src/project/index.js";

describe("project", () => {
  it("normalizes project slugs with unicode preserved", () => {
    expect(normalizeProjectSlug(" My Project_123 ")).toBe("my-project-123");
    expect(normalizeProjectSlug("멤베이스 Claude Plugin")).toBe(
      "멤베이스-claude-plugin",
    );
  });
});
