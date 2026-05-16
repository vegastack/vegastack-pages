import { describe, expect, it } from "vitest";
import { buildEnvelope, jsonWithEnvelope } from "../envelope";

describe("buildEnvelope", () => {
  it("emits the minimum required fields with sensible defaults", () => {
    const envelope = buildEnvelope({
      treeVersion: "nav_abc",
      changedResources: ["page:pg_1"],
    });
    expect(envelope.tree_version).toBe("nav_abc");
    expect(envelope.navigation_invalidated).toBe(false);
    expect(envelope.changed_resources).toEqual(["page:pg_1"]);
    expect(envelope.content_hash).toBeUndefined();
  });

  it("preserves content_hash when provided", () => {
    const envelope = buildEnvelope({
      treeVersion: "nav_abc",
      contentHash: "sha256:deadbeef",
      changedResources: ["page:pg_1"],
    });
    expect(envelope.content_hash).toBe("sha256:deadbeef");
  });

  it("flips navigation_invalidated when asked", () => {
    const envelope = buildEnvelope({
      treeVersion: "nav_abc",
      navigationInvalidated: true,
      changedResources: ["folder:fl_1"],
    });
    expect(envelope.navigation_invalidated).toBe(true);
  });

  it("deduplicates changed_resources", () => {
    const envelope = buildEnvelope({
      treeVersion: "nav_abc",
      changedResources: ["page:pg_1", "page:pg_1", "page:pg_2"],
    });
    expect(envelope.changed_resources).toEqual(["page:pg_1", "page:pg_2"]);
  });
});

describe("jsonWithEnvelope", () => {
  it("merges body fields with envelope at the top level", async () => {
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    const response = jsonWithEnvelope(
      { page_id: "pg_1", version_id: "ver_1" },
      envelope,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.page_id).toBe("pg_1");
    expect(body.version_id).toBe("ver_1");
    expect(body.envelope).toEqual(envelope);
  });

  it("honors a custom status via ResponseInit", async () => {
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    const response = jsonWithEnvelope({ created: true }, envelope, {
      status: 201,
    });
    expect(response.status).toBe(201);
  });
});
