import { describe, expect, it } from "vitest";
import {
  humanizeFrontmatterKey,
  isManagedMetadataKey,
} from "./frontmatter-labels";

describe("humanizeFrontmatterKey", () => {
  it("converts snake_case to sentence case", () => {
    expect(humanizeFrontmatterKey("created_at")).toBe("Created at");
    expect(humanizeFrontmatterKey("updated_at")).toBe("Updated at");
    expect(humanizeFrontmatterKey("for_audience")).toBe("For audience");
    expect(humanizeFrontmatterKey("last_edited_by")).toBe("Last edited by");
  });

  it("handles kebab-case the same way", () => {
    expect(humanizeFrontmatterKey("for-audience")).toBe("For audience");
  });

  it("breaks camelCase into separate words", () => {
    expect(humanizeFrontmatterKey("forAudience")).toBe("For audience");
    expect(humanizeFrontmatterKey("lastEditedBy")).toBe("Last edited by");
  });

  it("sentence-cases single-word keys", () => {
    expect(humanizeFrontmatterKey("owner")).toBe("Owner");
    expect(humanizeFrontmatterKey("summary")).toBe("Summary");
  });

  it("preserves short ALL-CAPS acronyms", () => {
    expect(humanizeFrontmatterKey("api_key")).toBe("Api key");
    expect(humanizeFrontmatterKey("API_key")).toBe("API key");
    expect(humanizeFrontmatterKey("mcp_session_id")).toBe("Mcp session id");
    expect(humanizeFrontmatterKey("MCP_session_id")).toBe("MCP session id");
  });

  it("collapses repeated separators and whitespace", () => {
    expect(humanizeFrontmatterKey("for__audience")).toBe("For audience");
    expect(humanizeFrontmatterKey("  for_audience  ")).toBe("For audience");
  });

  it("returns empty string for empty input", () => {
    expect(humanizeFrontmatterKey("")).toBe("");
    expect(humanizeFrontmatterKey("   ")).toBe("");
  });
});

describe("isManagedMetadataKey", () => {
  it("matches the system-managed metadata keys", () => {
    expect(isManagedMetadataKey("created_at")).toBe(true);
    expect(isManagedMetadataKey("updated_at")).toBe(true);
  });

  it("does not match user keys", () => {
    expect(isManagedMetadataKey("owner")).toBe(false);
    expect(isManagedMetadataKey("summary")).toBe(false);
    expect(isManagedMetadataKey("title")).toBe(false);
  });
});
