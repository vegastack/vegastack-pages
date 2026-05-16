import { describe, expect, it } from "vitest";
import { authService, pageService, workspaceService } from "../runtime";
import type { RequestActor } from "../access";
import {
  buildPageDocumentPayload,
  buildFolderDocumentPayload,
} from "../document-payload";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

async function seedPageFixture(opts?: {
  source?: string;
  title?: string;
  folderPath?: string;
}) {
  const workspace = workspaceService.createWorkspace({
    id: uniqueId("wks"),
    name: `Doc Payload Fixture ${crypto.randomUUID()}`,
  });
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `doc-payload-${crypto.randomUUID()}@example.test`,
    displayName: "Doc Reader",
  });
  workspaceService.addMember({
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
  });
  const page = await pageService.createPage({
    id: uniqueId("pg"),
    workspaceId: workspace.id,
    folderPath: opts?.folderPath ?? "",
    title: opts?.title ?? "Document Payload Sample",
    sourceType: "markdown",
    source:
      opts?.source ??
      "---\ntitle: Document Payload Sample\ndescription: Probe.\n---\n\n# Document Payload Sample\n\nProse body with a [link](/p/elsewhere).\n\n## Section\n\nMore prose.",
  });
  const actor: RequestActor = {
    user,
    sessionId: authService.createSession(user.id).id,
    devFallback: false,
    workspaceId: workspace.id,
    authMode: "session",
  };
  return { workspace, user, page, actor };
}

describe("buildPageDocumentPayload", () => {
  it("returns the canonical shape for a markdown page", async () => {
    const { workspace, user, page, actor } = await seedPageFixture();
    const payload = await buildPageDocumentPayload(page.page.slugId, actor);
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("page");
    expect(payload!.workspace).toEqual({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    });
    expect(payload!.page?.id).toBe(page.page.id);
    expect(payload!.page?.slug_id).toBe(page.page.slugId);
    expect(payload!.page?.title).toBe("Document Payload Sample");
    expect(payload!.page?.content_hash).toBe(page.page.contentHash);
    expect(payload!.page?.version_id).toBe(page.page.versionId);
    expect(payload!.page?.source_type).toBe("markdown");
    // document_html is the full swappable inner of <div id="vpg-document">:
    // title H1 + description + metadata + prose body. The prose-title H1
    // is emitted (sibling of prose content). The duplicate H1 inside the
    // markdown body is stripped to avoid showing the title twice.
    expect(payload!.document_html).toContain('<h1 class="prose-title">');
    expect(payload!.document_html).toContain("Prose body");
    // The original H1 (which duplicates the frontmatter title) has been
    // stripped from the rendered prose chunk.
    const proseChunk = payload!.document_html
      .split('<div class="prose"')
      .pop()!;
    expect(proseChunk).not.toMatch(/<h1[^>]*>\s*Document Payload Sample/);
    expect(payload!.permissions.canEdit).toBe(true);
    expect(payload!.permissions.canAdmin).toBe(true);
    expect(payload!.permissions.role).toBe("Owner");
    expect(payload!.comments_stats).toEqual({
      open: 0,
      resolved: 0,
      last_activity_at: null,
    });
    expect(payload!.favorite).toBe(false);
    expect(payload!.cache_control).toBe("private, no-store");
    expect(payload!.tree_version).toMatch(/^nav_/);
    // Breadcrumb always starts with workspace + ends at the page itself.
    expect(payload!.breadcrumb.items[0].kind).toBe("workspace");
    expect(
      payload!.breadcrumb.items[payload!.breadcrumb.items.length - 1].kind,
    ).toBe("page");
    expect(
      payload!.breadcrumb.items[payload!.breadcrumb.items.length - 1].id,
    ).toBe(page.page.id);
    // User exists; suppress unused-binding warning by asserting role.
    expect(user.id).toBeTruthy();
  });

  it("accepts both slug_id and pg_* id refs", async () => {
    const { page, actor } = await seedPageFixture();
    const bySlug = await buildPageDocumentPayload(page.page.slugId, actor);
    const byId = await buildPageDocumentPayload(page.page.id, actor);
    expect(bySlug?.page?.id).toBe(page.page.id);
    expect(byId?.page?.id).toBe(page.page.id);
  });

  it("returns null when the ref doesn't resolve", async () => {
    const { actor } = await seedPageFixture();
    const payload = await buildPageDocumentPayload("no-such-slug-or-id", actor);
    expect(payload).toBeNull();
  });

  it("emits a stable tree_version that changes when the tree changes", async () => {
    const { workspace, page, actor } = await seedPageFixture();
    const first = await buildPageDocumentPayload(page.page.slugId, actor);
    // Add a sibling page; tree_version must change.
    await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "",
      title: "Sibling Page",
      sourceType: "markdown",
      source: "# Sibling",
    });
    const second = await buildPageDocumentPayload(page.page.slugId, actor);
    expect(first!.tree_version).not.toBe(second!.tree_version);
  });

  it("declares feature_chunks for content that needs lazy bundles", async () => {
    const { page, actor } = await seedPageFixture({
      source: "# Diagram\n\n```mermaid\ngraph TD\nA-->B\n```\n",
    });
    const payload = await buildPageDocumentPayload(page.page.slugId, actor);
    expect(payload!.feature_chunks).toContain("mermaid");
  });
});

describe("buildFolderDocumentPayload", () => {
  it("returns a folder payload with workspace breadcrumb root", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: `Folder Fixture ${crypto.randomUUID()}`,
    });
    const user = workspaceService.createUser({
      id: uniqueId("usr"),
      email: `folder-${crypto.randomUUID()}@example.test`,
      displayName: "Folder Reader",
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: user.id,
      role: "admin",
    });
    const folder = workspaceService.createFolder({
      id: uniqueId("fl"),
      workspaceId: workspace.id,
      name: "Topics",
      parentFolderId: null,
    });
    const actor: RequestActor = {
      user,
      sessionId: authService.createSession(user.id).id,
      devFallback: false,
      workspaceId: workspace.id,
      authMode: "session",
    };
    const payload = await buildFolderDocumentPayload(folder.slugId, actor);
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("folder");
    expect(payload!.folder?.id).toBe(folder.id);
    expect(payload!.folder?.name).toBe("Topics");
    expect(payload!.breadcrumb.items[0].kind).toBe("workspace");
    expect(
      payload!.breadcrumb.items[payload!.breadcrumb.items.length - 1].id,
    ).toBe(folder.id);
    expect(payload!.cache_control).toBe("private, no-store");
  });
});
