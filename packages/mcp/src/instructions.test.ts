import { describe, expect, it } from "vitest";
import {
  mcpInstructions,
  mcpInstructionsMaxBytes,
  mcpToolNames,
} from "./index";

describe("mcpInstructions", () => {
  it("stays within the documented byte budget", () => {
    const bytes = new TextEncoder().encode(mcpInstructions).byteLength;
    expect(bytes).toBeLessThanOrEqual(mcpInstructionsMaxBytes);
  });

  it("teaches the load-bearing workflow keywords", () => {
    for (const keyword of [
      "prepare_page_edit",
      "patch_page",
      "wait_for_review",
      "complete_review_thread",
      "list_workspaces",
      "whoami",
      "workspace_id",
    ]) {
      expect(mcpInstructions).toContain(keyword);
    }
  });

  it("warns against the most common foot-guns", () => {
    expect(mcpInstructions).toMatch(
      /Don't pass `agent_name` to `reply_to_thread`/i,
    );
    expect(mcpInstructions).toMatch(
      /Don't `update_page` without a fresh `base_version_id`/i,
    );
  });

  it("references every tool spec name visible in tools/list", () => {
    // Instructions are a high-level distillation; we don't expect every tool
    // to be name-dropped, but the ones the agent must reason about up-front
    // should be present. The full surface lives in tools/list itself.
    const minimum = new Set([
      "prepare_page_edit",
      "patch_page",
      "update_page",
      "create_page",
      "publish_page",
      "wait_for_review",
      "list_comments",
      "complete_review_thread",
      "list_workspaces",
      "whoami",
    ]);
    for (const name of minimum) {
      expect(mcpToolNames).toContain(name);
      expect(mcpInstructions).toContain(name);
    }
  });
});
