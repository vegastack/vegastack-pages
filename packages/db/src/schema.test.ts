import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachments,
  authIdentities,
  pageFavorites,
  pages,
  permissions,
  publications,
  rateLimits,
  runtimeLocks,
  users,
  workspaces,
} from "./schema";

describe("schema", () => {
  it("exports core tables", () => {
    expect(users.id.name).toBe("id");
    expect(authIdentities.provider.name).toBe("provider");
    expect(workspaces.versionRetentionDays.name).toBe("version_retention_days");
    expect(pages.slugId.name).toBe("slug_id");
    expect(pageFavorites.pageId.name).toBe("page_id");
    expect(permissions.level.name).toBe("level");
    expect(attachments.objectKey.name).toBe("object_key");
    expect(publications.resourceId.name).toBe("resource_id");
    expect(rateLimits.resetAt.name).toBe("reset_at");
    expect(runtimeLocks.owner.name).toBe("owner");
  });

  it("keeps the initial migration aligned with critical tables", () => {
    const migration = readFileSync(
      join(import.meta.dirname, "../migrations/0001_initial.sql"),
      "utf8",
    );
    for (const table of [
      "auth_identities",
      "auth_sessions",
      "magic_links",
      "workspace_members",
      "permissions",
      "attachments",
      "agent_sessions",
      "mcp_sessions",
      "jobs",
      "search_documents_fts",
    ]) {
      expect(migration).toContain(
        `CREATE ${table === "search_documents_fts" ? "VIRTUAL " : ""}TABLE IF NOT EXISTS ${table}`,
      );
    }
  });
});
