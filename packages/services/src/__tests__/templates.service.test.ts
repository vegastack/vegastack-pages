import { describe, expect, it } from "vitest";
import type { StoredObject } from "@vegastack/pages-core";
import * as templates from "../templates.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

async function seedWorkspace(
  db: NonNullable<ServiceContext["db"]>,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    )
    .bind(workspaceId, `Workspace ${workspaceId}`, workspaceId, now)
    .run();
}

async function seedUser(db: NonNullable<ServiceContext["db"]>, userId: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'instance_admin', ?4, ?4)",
    )
    .bind(userId, `${userId}@example.test`, "User", now)
    .run();
}

function createRecordingStore() {
  const objects = new Map<string, StoredObject>();
  const calls = {
    puts: [] as Array<{ key: string; body: string; contentType?: string }>,
    deletes: [] as string[],
  };
  const store = {
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    async put(
      key: string,
      body: string,
      options: { contentType?: string } = {},
    ) {
      calls.puts.push({ key, body, contentType: options.contentType });
      const stored: StoredObject = {
        key,
        body,
        contentType: options.contentType,
        updatedAt: new Date().toISOString(),
      };
      objects.set(key, stored);
      return stored;
    },
    async delete(key: string) {
      calls.deletes.push(key);
      objects.delete(key);
    },
    async list(prefix: string) {
      return [...objects.values()].filter((o) => o.key.startsWith(prefix));
    },
  };
  return { store, calls, objects };
}

function makeCtx(actorUserId = "usr_actor") {
  const db = createTestD1();
  const { store, calls, objects } = createRecordingStore();
  const ctx: ServiceContext = {
    actor: { userId: actorUserId, email: null, workspaceId: null },
    db,
    objectStore: store,
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
  return { ctx, calls, objects };
}

const SAMPLE_SOURCE = `# {{ title }}\n\nWritten {{ date }}.\n`;

describe("templates.service", () => {
  it("create + getWithSource roundtrip", async () => {
    const { ctx, calls } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_t1");
    await seedUser(ctx.db!, "usr_actor");

    const created = await templates.create(ctx, {
      workspaceId: "wks_t1",
      slug: "meeting-notes",
      name: "Meeting Notes",
      description: "  Weekly sync notes  ",
      category: "  Business ",
      source: SAMPLE_SOURCE,
      properties: [{ key: "owner", label: "Owner", type: "text" }],
    });

    expect(created.id).toMatch(/^tpl_/);
    expect(created.versionId).toMatch(/^ver_/);
    expect(created.objectKeyCurrent).toMatch(
      /^templates\/wks_t1\/tpl_[0-9a-f]+\/source-[0-9a-f]{64}\.md$/,
    );
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.description).toBe("Weekly sync notes");
    expect(created.category).toBe("business");
    expect(created.sourceType).toBe("markdown");
    expect(created.createdBy).toBe("usr_actor");
    expect(created.isBuiltin).toBe(false);
    expect(created.properties).toEqual([
      { key: "owner", label: "Owner", type: "text" },
    ]);
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]!.key).toBe(created.objectKeyCurrent);

    const fetched = await templates.get(ctx, created.id);
    expect(fetched).toEqual(created);

    const withSource = await templates.getWithSource(ctx, created.id);
    expect(withSource).toEqual({ ...created, source: SAMPLE_SOURCE });

    // By-slug lookup hits the same row.
    const bySlug = await templates.getBySlug(ctx, {
      workspaceId: "wks_t1",
      slug: "meeting-notes",
    });
    expect(bySlug?.id).toBe(created.id);
  });

  it("update with new source creates a new version; without source leaves objectKeyCurrent alone", async () => {
    const { ctx, calls } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_t2");
    await seedUser(ctx.db!, "usr_actor");

    const created = await templates.create(ctx, {
      workspaceId: "wks_t2",
      slug: "rfc",
      name: "RFC",
      source: SAMPLE_SOURCE,
    });
    const initialKey = created.objectKeyCurrent;
    const initialVersion = created.versionId;
    const initialHash = created.contentHash;

    // Metadata-only update — keys + hash + version id all preserved.
    const metaOnly = await templates.update(ctx, created.id, {
      name: "RFC v2",
      description: "Tech design template",
    });
    expect(metaOnly.objectKeyCurrent).toBe(initialKey);
    expect(metaOnly.contentHash).toBe(initialHash);
    expect(metaOnly.versionId).toBe(initialVersion);
    expect(metaOnly.name).toBe("RFC v2");
    expect(metaOnly.description).toBe("Tech design template");
    // No extra blob write.
    expect(calls.puts).toHaveLength(1);

    // Source update — produces a new key, new hash, new version row.
    const newSource = `# {{ title }}\n\nUpdated body.\n`;
    const updated = await templates.update(ctx, created.id, {
      source: newSource,
      label: "Tightened guidance",
    });
    expect(updated.objectKeyCurrent).not.toBe(initialKey);
    expect(updated.contentHash).not.toBe(initialHash);
    expect(updated.versionId).not.toBe(initialVersion);
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[1]!.key).toBe(updated.objectKeyCurrent);

    const versions = await templates.listVersions(ctx, {
      templateId: created.id,
    });
    // Newest first — latest version row carries the label we passed in.
    expect(versions).toHaveLength(2);
    expect(versions[0]!.id).toBe(updated.versionId);
    expect(versions[0]!.label).toBe("Tightened guidance");
    expect(versions[1]!.id).toBe(initialVersion);
    expect(versions[1]!.label).toBe("Initial version");
  });

  it("listForWorkspace excludes soft-deleted templates", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_list");
    await seedUser(ctx.db!, "usr_actor");

    const keep = await templates.create(ctx, {
      workspaceId: "wks_list",
      slug: "keeper",
      name: "Keeper",
      category: "alpha",
      source: SAMPLE_SOURCE,
    });
    const drop = await templates.create(ctx, {
      workspaceId: "wks_list",
      slug: "drop-me",
      name: "Drop",
      category: "alpha",
      source: SAMPLE_SOURCE,
    });

    // Pre-delete: both surface in the listing.
    let listing = await templates.listForWorkspace(ctx, {
      workspaceId: "wks_list",
    });
    expect(listing.map((t) => t.id).sort()).toEqual([keep.id, drop.id].sort());

    await templates.remove(ctx, drop.id);

    listing = await templates.listForWorkspace(ctx, {
      workspaceId: "wks_list",
    });
    expect(listing.map((t) => t.id)).toEqual([keep.id]);

    // Direct get also reports null for the soft-deleted row.
    expect(await templates.get(ctx, drop.id)).toBeNull();
    // remove() is idempotent.
    await templates.remove(ctx, drop.id);
  });

  it("render delegates to template-builder for {{ title }} / {{ date }} substitution", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_render");
    await seedUser(ctx.db!, "usr_actor");

    const created = await templates.create(ctx, {
      workspaceId: "wks_render",
      slug: "weekly",
      name: "Weekly update",
      source: SAMPLE_SOURCE,
    });

    const rendered = await templates.render(ctx, {
      templateId: created.id,
      values: { title: "Sprint 42 wrap-up" },
    });
    expect(rendered.sourceType).toBe("markdown");
    expect(rendered.title).toBe("Sprint 42 wrap-up");
    expect(rendered.body).toContain("# Sprint 42 wrap-up");
    // {{ date }} is substituted with today's ISO date.
    expect(rendered.body).toMatch(/Written \d{4}-\d{2}-\d{2}\./);
    expect(rendered.body).not.toContain("{{ title }}");
    expect(rendered.body).not.toContain("{{ date }}");
  });

  it("rejects invalid slug and empty source on create", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_val");
    await seedUser(ctx.db!, "usr_actor");

    await expect(
      templates.create(ctx, {
        workspaceId: "wks_val",
        slug: "Not a Slug!",
        name: "Bad",
        source: SAMPLE_SOURCE,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });

    await expect(
      templates.create(ctx, {
        workspaceId: "wks_val",
        slug: "ok",
        name: "Empty",
        source: "   ",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });

  it("returns TEMPLATE_NOT_FOUND for missing template on update / render", async () => {
    const { ctx } = makeCtx();
    await seedWorkspace(ctx.db!, "wks_miss");

    await expect(
      templates.update(ctx, "tpl_does_not_exist", { name: "x" }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND", status: 404 });

    await expect(
      templates.render(ctx, {
        templateId: "tpl_does_not_exist",
        values: { title: "ignored" },
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND", status: 404 });
  });
});
