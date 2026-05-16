import { describe, expect, it } from "vitest";
import { buildEnvelope, attachEnvelope, jsonWithEnvelope } from "../envelope";

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
});

describe("attachEnvelope", () => {
  it("inserts envelope into an existing JSON response", async () => {
    const original = Response.json({ ok: true, page_id: "pg_1" });
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    const wrapped = await attachEnvelope(original, envelope);
    const body = (await wrapped.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.page_id).toBe("pg_1");
    expect(body.envelope).toEqual(envelope);
  });

  it("throws when the response body isn't JSON (audit F-014)", async () => {
    const original = new Response("plain text", {
      headers: { "content-type": "text/plain" },
    });
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    await expect(attachEnvelope(original, envelope)).rejects.toThrow(
      /JSON response/,
    );
  });

  it("throws when the JSON body is malformed (audit F-014)", async () => {
    const original = new Response("not-json {", {
      headers: { "content-type": "application/json" },
    });
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    await expect(attachEnvelope(original, envelope)).rejects.toThrow(
      /could not parse/,
    );
  });

  it("doesn't mutate error responses", async () => {
    const original = Response.json(
      { error: { code: "NOT_FOUND" } },
      { status: 404 },
    );
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    const wrapped = await attachEnvelope(original, envelope);
    expect(wrapped.status).toBe(404);
    const body = (await wrapped.json()) as Record<string, unknown>;
    expect(body.envelope).toBeUndefined();
  });

  it("wraps non-object JSON bodies under data + envelope", async () => {
    const original = Response.json([1, 2, 3]);
    const envelope = buildEnvelope({
      treeVersion: "nav_xyz",
      changedResources: ["page:pg_1"],
    });
    const wrapped = await attachEnvelope(original, envelope);
    const body = (await wrapped.json()) as Record<string, unknown>;
    expect(body.data).toEqual([1, 2, 3]);
    expect(body.envelope).toEqual(envelope);
  });
});
