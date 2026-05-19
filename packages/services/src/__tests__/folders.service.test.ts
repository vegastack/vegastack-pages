import { describe, expect, it } from "vitest";
import * as folders from "../folders.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

const WORKSPACE_ID = "wks_folders";

async function seedWorkspace(db: ReturnType<typeof createTestD1>) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    )
    .bind(WORKSPACE_ID, "Folders WS", WORKSPACE_ID, now)
    .run();
}

function makeCtx(): ServiceContext {
  const db = createTestD1();
  return {
    actor: { userId: "", email: null, workspaceId: null },
    db,
    objectStore: {
      get: async () => null,
      put: async () => ({
        key: "x",
        body: "",
        updatedAt: new Date().toISOString(),
      }),
      delete: async () => {},
      list: async () => [],
    },
    // The legacy repo registry isn't used by the folders service.
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
}

describe("folders.service", () => {
  it("creates root + child folders with the expected path shape", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);

    const root = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "Docs Folder",
    });
    expect(root.id).toMatch(/^fld_/);
    expect(root.slug).toBe("docs-folder");
    expect(root.path).toBe("/docs-folder");
    expect(root.parentFolderId).toBeNull();
    expect(root.position).toBe(1);
    expect(root.slugId).toMatch(/^[a-z0-9]{12}$/);

    const child = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "Guides",
    });
    expect(child.parentFolderId).toBe(root.id);
    expect(child.path).toBe("/docs-folder/guides");
    expect(child.slug).toBe("guides");

    const sibling = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "References",
    });
    // Auto-positioned after the first child under the same parent.
    expect(sibling.position).toBe(2);
  });

  it("listForParent and listAll order correctly", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);
    const root = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "Root",
    });
    const a = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "Alpha",
    });
    const b = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "Beta",
    });

    const roots = await folders.listForParent(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
    });
    expect(roots.map((f) => f.id)).toEqual([root.id]);

    const children = await folders.listForParent(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
    });
    expect(children.map((f) => f.id)).toEqual([a.id, b.id]);

    const all = await folders.listAll(ctx, { workspaceId: WORKSPACE_ID });
    expect(all).toHaveLength(3);
    // Sorted by path: "/root", "/root/alpha", "/root/beta".
    expect(all.map((f) => f.path)).toEqual([
      "/root",
      "/root/alpha",
      "/root/beta",
    ]);
  });

  it("rename rewrites the slug + path on the folder AND descendants", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);
    const root = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "Old Name",
    });
    const child = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "Child",
    });
    const grandchild = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: child.id,
      name: "Grand",
    });
    expect(grandchild.path).toBe("/old-name/child/grand");

    const renamed = await folders.rename(ctx, {
      folderId: root.id,
      name: "Shiny New",
    });
    expect(renamed.slug).toBe("shiny-new");
    expect(renamed.path).toBe("/shiny-new");

    const reloadedChild = await folders.get(ctx, child.id);
    const reloadedGrand = await folders.get(ctx, grandchild.id);
    expect(reloadedChild?.path).toBe("/shiny-new/child");
    expect(reloadedGrand?.path).toBe("/shiny-new/child/grand");

    // Empty / unsluggable names fall back to "folder".
    const fallback = await folders.rename(ctx, {
      folderId: child.id,
      name: "###",
    });
    expect(fallback.slug).toBe("folder");
    expect(fallback.path).toBe("/shiny-new/folder");
    const reloadedGrandAgain = await folders.get(ctx, grandchild.id);
    expect(reloadedGrandAgain?.path).toBe("/shiny-new/folder/grand");
  });

  it("move relocates the folder, brings descendants along, and rejects cycles", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);
    const a = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "A",
    });
    const b = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "B",
    });
    const aChild = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: a.id,
      name: "Alpha",
    });
    const aGrand = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: aChild.id,
      name: "Gamma",
    });

    // Move A under B. A + descendants follow.
    const moved = await folders.move(ctx, {
      folderId: a.id,
      parentFolderId: b.id,
    });
    expect(moved.parentFolderId).toBe(b.id);
    expect(moved.path).toBe("/b/a");

    const reloadedChild = await folders.get(ctx, aChild.id);
    const reloadedGrand = await folders.get(ctx, aGrand.id);
    expect(reloadedChild?.path).toBe("/b/a/alpha");
    expect(reloadedGrand?.path).toBe("/b/a/alpha/gamma");

    // Cannot move B under its new descendant A.
    await expect(
      folders.move(ctx, { folderId: b.id, parentFolderId: a.id }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
    // Cannot move B under itself.
    await expect(
      folders.move(ctx, { folderId: b.id, parentFolderId: b.id }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // Cannot move B under a deeper descendant of itself.
    await expect(
      folders.move(ctx, { folderId: b.id, parentFolderId: aGrand.id }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    // Moving back to root works.
    const movedBack = await folders.move(ctx, {
      folderId: a.id,
      parentFolderId: null,
    });
    expect(movedBack.parentFolderId).toBeNull();
    expect(movedBack.path).toBe("/a");
    const grandBack = await folders.get(ctx, aGrand.id);
    expect(grandBack?.path).toBe("/a/alpha/gamma");
  });

  it("remove cascades to descendants and reports the count", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);
    const root = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "Root",
    });
    const child = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "Child",
    });
    const grand = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: child.id,
      name: "Grand",
    });

    const { removed } = await folders.remove(ctx, root.id);
    expect(removed).toBe(3);

    expect(await folders.get(ctx, root.id)).toBeNull();
    expect(await folders.get(ctx, child.id)).toBeNull();
    expect(await folders.get(ctx, grand.id)).toBeNull();
    expect(
      await folders.listAll(ctx, { workspaceId: WORKSPACE_ID }),
    ).toHaveLength(0);
  });

  it("ancestorPath walks root → folder in order", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);
    const root = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "Root",
    });
    const mid = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: root.id,
      name: "Mid",
    });
    const leaf = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: mid.id,
      name: "Leaf",
    });

    expect(await folders.ancestorPath(ctx, leaf.id)).toEqual([
      root.id,
      mid.id,
      leaf.id,
    ]);
    expect(await folders.ancestorPath(ctx, root.id)).toEqual([root.id]);
    expect(await folders.ancestorPath(ctx, "fld_missing")).toEqual([]);
  });

  it("get and getBySlugId resolve, with not-found surfaces", async () => {
    const ctx = makeCtx();
    await seedWorkspace(ctx.db!);
    const root = await folders.create(ctx, {
      workspaceId: WORKSPACE_ID,
      parentFolderId: null,
      name: "Lookup",
    });
    expect((await folders.get(ctx, root.id))?.id).toBe(root.id);
    expect((await folders.getBySlugId(ctx, root.slugId))?.id).toBe(root.id);

    expect(await folders.get(ctx, "fld_missing")).toBeNull();
    expect(await folders.getBySlugId(ctx, "missingslugd")).toBeNull();

    // Rename on a missing id surfaces FOLDER_NOT_FOUND.
    await expect(
      folders.rename(ctx, { folderId: "fld_missing", name: "X" }),
    ).rejects.toMatchObject({
      code: "FOLDER_NOT_FOUND",
      status: 404,
    });
  });
});
