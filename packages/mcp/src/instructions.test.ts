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
      "fetch",
      "update_page",
      "wait_for_review",
      "update_thread",
      "whoami",
      "workspace_id",
      "edit_tokens",
      "include",
    ]) {
      expect(mcpInstructions).toContain(keyword);
    }
  });

  it("warns against the most common foot-guns", () => {
    expect(mcpInstructions).toMatch(
      /Don't `update_page` without a fresh `base_version_id`/i,
    );
    // Pure cutover: enumerating removed tool names in the agent
    // instructions just wastes context. The post-cycle-5 contract is
    // simpler — the surface IS the tool list, and the foot-guns are
    // the live mode-conflict + workspace-id guidance.
    expect(mcpInstructions).toMatch(
      /Don't pass both `source` and `find` to `update_page`/i,
    );
    expect(mcpInstructions).toMatch(/Don't infer `workspace_id`/i);
  });

  it("name-drops every tool the agent must reason about up front", () => {
    const minimum = new Set([
      "fetch",
      "search",
      "create_page",
      "update_page",
      "create_comment",
      "update_thread",
      "apply_publication",
      "delete_publication",
      "wait_for_review",
      "whoami",
    ]);
    for (const name of minimum) {
      expect(mcpToolNames).toContain(name);
      expect(mcpInstructions).toContain(name);
    }
  });
});
