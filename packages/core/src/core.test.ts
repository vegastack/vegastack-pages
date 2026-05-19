import { describe, expect, it } from "vitest";
import {
  AppError,
  AttachmentService,
  AuditService,
  AuthService,
  CommentService,
  createId,
  hasPermission,
  InMemoryObjectStore,
  makeFolderSlugId,
  makePageSlugId,
  PageService,
  parsePageSlugId,
  permissionForShare,
  reanchorText,
  SearchService,
  slugifyTitle,
  ReviewEventService,
  RateLimiter,
  PermissionService,
  permissionForPublication,
  permissionForWorkspaceRole,
  PublicationService,
  resolveEffectivePermission,
  R2ObjectStore,
  SetupService,
  WorkspaceService,
} from ".";

describe("ids", () => {
  it("creates stable public page slug ids", () => {
    const slug = makePageSlugId(
      "API Review: Phase 1",
      "pg_a8f31c000000000000000000",
    );
    expect(slug).toBe("api-review-phase-1-a8f31c000000");
    expect(parsePageSlugId(slug)).toEqual({
      titleSlug: "api-review-phase-1",
      shortId: "a8f31c000000",
    });
  });

  it("creates prefixed opaque ids", () => {
    expect(createId("pg", "123e4567-e89b-12d3-a456-426614174000")).toBe(
      "pg_123e4567e89b12d3a456426614174000",
    );
  });

  it("normalizes empty and accented slugs and rejects malformed page slug ids", () => {
    expect(slugifyTitle("  Déjà vu / Résumé  ")).toBe("deja-vu-resume");
    expect(slugifyTitle("!!!")).toBe("untitled");
    expect(makeFolderSlugId("!!!", "fld_abc123000000")).toBe(
      "untitled-abc123000000",
    );
    expect(() => parsePageSlugId("missing-suffix-")).toThrow(
      "Invalid page slug id",
    );
    expect(() => parsePageSlugId("nosuffix")).toThrow("Invalid page slug id");
  });
});

describe("rate limiter", () => {
  it("rejects requests over the configured window", () => {
    const limiter = new RateLimiter();
    limiter.check({
      key: "magic:admin@example.com",
      limit: 1,
      windowMs: 60_000,
    });
    expect(() =>
      limiter.check({
        key: "magic:admin@example.com",
        limit: 1,
        windowMs: 60_000,
      }),
    ).toThrow(AppError);
  });
});

describe("permissions", () => {
  it("compares hierarchical permissions", () => {
    expect(hasPermission("write", "comment")).toBe(true);
    expect(hasPermission("read", "write")).toBe(false);
  });

  it("maps roles and share scopes into permission levels", () => {
    expect(permissionForWorkspaceRole("reader")).toBe("read");
    expect(permissionForWorkspaceRole("commenter")).toBe("comment");
    expect(permissionForWorkspaceRole("editor")).toBe("write");
    expect(permissionForWorkspaceRole("admin")).toBe("admin");
    expect(permissionForShare("view")).toBe("read");
    expect(permissionForShare("comment")).toBe("comment");
    expect(permissionForShare("edit")).toBe("write");
    expect(permissionForPublication("view")).toBe("read");
    expect(permissionForPublication("comment")).toBe("comment");
    expect(permissionForPublication("edit")).toBe("write");
  });

  it("resolves effective grants with closer explicit deny", () => {
    expect(
      resolveEffectivePermission([
        { scope: "workspace", level: "write" },
        { scope: "page", level: "none", explicitDeny: true },
      ]),
    ).toBe("none");
  });

  it("resolves effective grants independently of input order", () => {
    const denyFirst = resolveEffectivePermission([
      { scope: "page", level: "none", explicitDeny: true },
      { scope: "workspace", level: "admin" },
    ]);
    const denyLast = resolveEffectivePermission([
      { scope: "workspace", level: "admin" },
      { scope: "page", level: "none", explicitDeny: true },
    ]);

    expect(denyFirst).toBe("none");
    expect(denyLast).toBe("none");
  });

  it("filters, replaces, deletes, and asserts explicit grants", () => {
    const permissions = new PermissionService();
    const grant = permissions.setGrant({
      id: "perm_one",
      workspaceId: "wks_test",
      subjectId: "usr_test",
      scope: "workspace",
      targetId: "wks_test",
      level: "read",
    });
    const replaced = permissions.setGrant({
      workspaceId: "wks_test",
      subjectId: "usr_test",
      scope: "workspace",
      targetId: "wks_test",
      level: "write",
    });
    permissions.setGrant({
      id: "perm_other",
      workspaceId: "wks_test",
      subjectId: "usr_other",
      scope: "page",
      targetId: "pg_test",
      level: "comment",
    });

    expect(replaced.id).toBe(grant.id);
    expect(
      permissions.listGrants({
        workspaceId: "wks_test",
        subjectId: "usr_test",
      }),
    ).toEqual([expect.objectContaining({ id: "perm_one", level: "write" })]);
    expect(
      permissions.listGrants({
        workspaceId: "wks_test",
        scope: "page",
        targetId: "pg_test",
      }),
    ).toEqual([expect.objectContaining({ id: "perm_other" })]);
    expect(() =>
      permissions.assert({ actual: "read", required: "write" }),
    ).toThrow(AppError);
    expect(() =>
      permissions.assert({ actual: "admin", required: "write" }),
    ).not.toThrow();
    expect(permissions.deleteGrant("perm_other").id).toBe("perm_other");
    expect(() => permissions.deleteGrant("missing")).toThrow(AppError);
    expect(
      permissions.deleteGrantsForSubject({
        workspaceId: "wks_test",
        subjectId: "usr_test",
      }),
    ).toEqual([expect.objectContaining({ id: "perm_one" })]);
    expect(
      permissions.listGrants({
        workspaceId: "wks_test",
        subjectId: "usr_test",
      }),
    ).toEqual([]);
  });
});

describe("anchors", () => {
  it("reanchors selected text after nearby edits", () => {
    const result = reanchorText("Intro\nUpdated selected text here\nEnd", {
      selectedText: "selected text",
      sourceStart: 6,
      sourceEnd: 19,
      prefixText: "Updated ",
      suffixText: " here",
      contentHash: "old",
    });

    expect(result.status).toBe("reanchored");
    expect(result.start).toBe(14);
  });

  it("keeps active anchors and falls back through context, global, then stale", () => {
    const active = reanchorText("before selected after", {
      selectedText: "selected",
      sourceStart: 7,
      sourceEnd: 15,
      prefixText: "before ",
      suffixText: " after",
      contentHash: "hash",
    });
    expect(active).toEqual({ status: "active", start: 7, end: 15 });

    const contextual = reanchorText("intro before selected after outro", {
      selectedText: "selected",
      sourceStart: 1000,
      sourceEnd: 1008,
      prefixText: "before ",
      suffixText: " after",
      contentHash: "hash",
    });
    expect(contextual).toEqual({ status: "reanchored", start: 13, end: 21 });

    const global = reanchorText("intro selected outro", {
      selectedText: "selected",
      sourceStart: null,
      sourceEnd: null,
      prefixText: "",
      suffixText: "",
      contentHash: "hash",
    });
    expect(global).toEqual({ status: "reanchored", start: 6, end: 14 });

    const stale = reanchorText("intro outro", {
      selectedText: "missing",
      sourceStart: null,
      sourceEnd: null,
      prefixText: "",
      suffixText: "",
      contentHash: "hash",
    });
    expect(stale.status).toBe("stale");
  });
});

describe("page service", () => {
  it("creates pages in object storage with an initial version", async () => {
    const service = new PageService(new InMemoryObjectStore());
    const created = await service.createPage({
      id: "pg_a8f31c000000000000000000",
      workspaceId: "wks_test",
      folderPath: "Agents",
      title: "Review Plan",
      sourceType: "markdown",
      source: "# Review Plan",
    });

    expect(created.page.slugId).toBe("review-plan-a8f31c000000");
    expect(created.source).toBe("# Review Plan");
    expect(service.listVersions(created.page.id)).toHaveLength(1);

    const fetched = await service.getPageBySlugId(created.page.slugId);
    expect(fetched?.page.id).toBe(created.page.id);
  });

  it("stores html pages with normalized paths and html content type", async () => {
    const objectStore = new InMemoryObjectStore();
    const service = new PageService(objectStore);
    const created = await service.createPage({
      workspaceId: "wks_test",
      folderPath: "/Guides/API/",
      title: "HTML Page",
      sourceType: "html",
      source: "<h1>HTML</h1>",
    });

    expect(created.page.folderPath).toBe("Guides/API");
    expect(created.page.objectKeyCurrent).toMatch(/current\.html$/);
    expect(
      (await objectStore.get(created.page.objectKeyCurrent))?.contentType,
    ).toBe("text/html; charset=utf-8");
    expect(await service.getPageBySlugId("missing")).toBeNull();
    expect(service.listPages()).toEqual([created.page]);
  });

  it("rejects stale source updates and supports checkpoints", async () => {
    const service = new PageService(new InMemoryObjectStore());
    const created = await service.createPage({
      workspaceId: "wks_test",
      title: "Conflict Test",
      sourceType: "markdown",
      source: "# One",
    });

    const updated = await service.updateSource({
      pageId: created.page.id,
      baseVersionId: created.page.versionId,
      source: "# Two",
      checkpoint: true,
      checkpointLabel: "Manual",
    });

    expect(updated.checkpointCreated).toBe(true);
    expect(service.listVersions(created.page.id)).toHaveLength(2);

    await expect(
      service.updateSource({
        pageId: created.page.id,
        baseVersionId: created.page.versionId,
        source: "# Three",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("creates automatic time checkpoints without versioning every autosave", async () => {
    const service = new PageService(new InMemoryObjectStore(), {
      checkpointIntervalMs: 10 * 60_000,
    });
    const created = await service.createPage({
      workspaceId: "wks_test",
      title: "Checkpoint Policy",
      sourceType: "markdown",
      source: "# One",
    });
    const initialVersion = service.listVersions(created.page.id)[0];
    initialVersion!.createdAt = new Date(
      Date.now() - 11 * 60_000,
    ).toISOString();

    const firstSave = await service.updateSource({
      pageId: created.page.id,
      baseVersionId: created.page.versionId,
      source: "# Two",
      checkpoint: false,
    });
    expect(firstSave.checkpointCreated).toBe(true);
    expect(service.listVersions(created.page.id).at(-1)?.createdReason).toBe(
      "time_checkpoint",
    );

    const secondSave = await service.updateSource({
      pageId: created.page.id,
      baseVersionId: firstSave.page.versionId,
      source: "# Three",
      checkpoint: false,
    });
    expect(secondSave.checkpointCreated).toBe(false);
    expect(secondSave.page.versionId).not.toBe(firstSave.page.versionId);
    expect(service.listVersions(created.page.id)).toHaveLength(2);
  });

  it("renames and moves pages while preserving the 12-character public id", async () => {
    const service = new PageService(new InMemoryObjectStore());
    const created = await service.createPage({
      id: "pg_a8f31c000000000000000000",
      workspaceId: "wks_test",
      title: "Old Title",
      sourceType: "markdown",
      source: "# Old",
    });

    const moved = service.movePage({
      pageId: created.page.id,
      title: "New Title",
      folderPath: "/Guides/API/",
    });

    expect(moved.folderPath).toBe("Guides/API");
    expect(moved.slugId).toBe("new-title-a8f31c000000");
    await expect(
      service.getPageBySlugId("old-title-a8f31c000000"),
    ).resolves.toEqual(expect.objectContaining({ page: moved }));
    await expect(
      service.getPageBySlugId("old-title-a8f31c"),
    ).resolves.toBeNull();
  });

  it("reads version source for restore workflows", async () => {
    const service = new PageService(new InMemoryObjectStore());
    const created = await service.createPage({
      workspaceId: "wks_test",
      title: "History",
      sourceType: "markdown",
      source: "# One",
    });
    const initialVersion = service.listVersions(created.page.id)[0]!;
    const version = await service.getVersionSource(
      created.page.id,
      initialVersion.id,
    );
    expect(version.source).toBe("# One");

    await objectStoreDeleteCurrentVersion(service, created.page.id);
    await expect(
      service.getVersionSource(created.page.id, initialVersion.id),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.getVersionSource(created.page.id, "ver_missing"),
    ).rejects.toBeInstanceOf(AppError);
  });
});

async function objectStoreDeleteCurrentVersion(
  service: PageService,
  pageId: string,
) {
  const internal = service as unknown as {
    objectStore: InMemoryObjectStore;
    versions: Map<string, Array<{ objectKey: string }>>;
  };
  const version = internal.versions.get(pageId)?.[0];
  if (!version) throw new Error("Expected page version.");
  await internal.objectStore.delete(version.objectKey);
}

describe("setup service", () => {
  it("completes setup once with a valid token", () => {
    const setup = new SetupService();
    const result = setup.complete({
      setupToken: "dev",
      expectedSetupToken: "dev",
      adminEmail: "admin@example.com",
      adminName: "Admin",
      workspaceName: "Acme Docs",
      adminUserId: "usr_admin",
      workspaceId: "wks_acme",
    });

    expect(result.workspaceName).toBe("Acme Docs");
    expect(setup.status().firstWorkspaceId).toBe("wks_acme");
    expect(setup.status().setupComplete).toBe(true);
    expect(() =>
      setup.complete({
        setupToken: "dev",
        expectedSetupToken: "dev",
        adminEmail: "admin@example.com",
        adminName: "Admin",
        workspaceName: "Acme Docs",
      }),
    ).toThrow(AppError);
  });

  it("rejects invalid setup tokens and missing fields", () => {
    const setup = new SetupService();
    expect(() =>
      setup.complete({
        setupToken: "wrong",
        expectedSetupToken: "right",
        adminEmail: "admin@example.com",
        adminName: "Admin",
        workspaceName: "Docs",
      }),
    ).toThrow(AppError);
    expect(() =>
      setup.complete({
        setupToken: "right",
        expectedSetupToken: "right",
        adminEmail: "",
        adminName: "Admin",
        workspaceName: "Docs",
      }),
    ).toThrow(AppError);
  });
});

describe("comment service", () => {
  it("creates, replies to, and resolves anchored threads", () => {
    const comments = new CommentService();
    const created = comments.createThread({
      pageId: "pg_test",
      workspaceId: "wks_test",
      body: "Please clarify.",
      anchor: {
        selectedText: "selected text",
        sourceStart: 10,
        sourceEnd: 23,
        prefixText: "before ",
        suffixText: " after",
        contentHash: "hash",
      },
      guestName: "Mira",
    });

    expect(created.thread.status).toBe("open");
    expect(created.replies[0]?.authorType).toBe("guest");

    const agentReply = comments.reply({
      threadId: created.thread.id,
      body: "Updated.",
      authorType: "agent",
      agent: { name: "Codex", model: "gpt-5", sessionId: "agt_1" },
    });
    expect(agentReply.agentName).toBe("Codex");
    expect(comments.getThread(created.thread.id)?.replies).toHaveLength(2);

    comments.resolve(created.thread.id);
    expect(comments.listForPage("pg_test")).toHaveLength(0);
    comments.unresolve(created.thread.id);
    expect(comments.listForPage("pg_test")).toHaveLength(1);
    comments.resolve(created.thread.id);
    expect(comments.listForPage("pg_test", "all")).toHaveLength(1);

    comments.deleteThread(created.thread.id);
    expect(comments.getThread(created.thread.id)).toBeNull();
    expect(comments.listForPage("pg_test", "all")).toHaveLength(0);
  });

  it("stores visual anchors and lets commenters manually re-anchor open threads", () => {
    const comments = new CommentService();
    const created = comments.createThread({
      pageId: "pg_test",
      workspaceId: "wks_test",
      body: "Move this callout.",
      anchor: {
        selectedText: "Pinned comment",
        sourceStart: null,
        sourceEnd: null,
        prefixText: "",
        suffixText: "",
        contentHash: "hash",
        kind: "point",
        surface: "html",
        selector: {
          point: {
            x: 0.4,
            y: 0.3,
            coordinateSpace: "document",
            elementPath: "main>section:nth-of-type(1)",
          },
        },
        confidence: "manual",
      },
    });

    expect(created.anchor.kind).toBe("point");
    expect(created.anchor.surface).toBe("html");
    expect(created.anchor.selector?.point?.x).toBe(0.4);

    const updated = comments.updateAnchor({
      threadId: created.thread.id,
      anchor: {
        selectedText: "Pinned comment",
        sourceStart: null,
        sourceEnd: null,
        prefixText: "",
        suffixText: "",
        contentHash: "hash-2",
        kind: "point",
        surface: "prose",
        selector: {
          point: {
            x: 0.2,
            y: 0.4,
            coordinateSpace: "document",
          },
        },
        confidence: "manual",
      },
    });

    expect(updated.kind).toBe("point");
    expect(updated.confidence).toBe("manual");
    expect(updated.reanchorStatus).toBe("reanchored");
    expect(comments.getThread(created.thread.id)?.thread.updatedAt).toEqual(
      expect.any(String),
    );
  });

  it("rejects invalid comment and reply operations", () => {
    const comments = new CommentService();
    expect(() =>
      comments.createThread({
        pageId: "pg_test",
        workspaceId: "wks_test",
        body: " ",
        anchor: {
          selectedText: "text",
          sourceStart: 0,
          sourceEnd: 4,
          prefixText: "",
          suffixText: "",
          contentHash: "hash",
        },
      }),
    ).toThrow(AppError);
    expect(() =>
      comments.createThread({
        pageId: "pg_test",
        workspaceId: "wks_test",
        body: "Body",
        anchor: {
          selectedText: " ",
          sourceStart: 0,
          sourceEnd: 1,
          prefixText: "",
          suffixText: "",
          contentHash: "hash",
        },
      }),
    ).toThrow(AppError);
    expect(() =>
      comments.reply({
        threadId: "missing",
        body: "Reply",
        authorType: "user",
      }),
    ).toThrow(AppError);
    const created = comments.createThread({
      pageId: "pg_test",
      workspaceId: "wks_test",
      body: "Body",
      authorUserId: "usr_test",
      anchor: {
        selectedText: "text",
        sourceStart: 0,
        sourceEnd: 4,
        prefixText: "",
        suffixText: "",
        contentHash: "hash",
      },
    });
    expect(created.replies[0]?.authorType).toBe("user");
    expect(() =>
      comments.reply({
        threadId: created.thread.id,
        body: " ",
        authorType: "user",
      }),
    ).toThrow(AppError);
    expect(() => comments.resolve("missing")).toThrow(AppError);
    expect(() => comments.unresolve("missing")).toThrow(AppError);
    expect(() => comments.deleteThread("missing")).toThrow(AppError);
  });
});

describe("review event service", () => {
  it("records workspace and page scoped events after a cursor", () => {
    const events = new ReviewEventService();
    const first = events.emit({
      workspaceId: "wks_test",
      pageId: "pg_test",
      type: "comment.created",
      actorUserId: "usr_test",
      payload: { thread_id: "thr_test" },
    });
    events.emit({
      workspaceId: "wks_test",
      pageId: "pg_test",
      type: "comment.replied",
      actorUserId: "usr_test",
      payload: { thread_id: "thr_test" },
    });

    expect(events.list({ pageId: "pg_test", afterId: first.id })).toEqual([
      expect.objectContaining({ type: "comment.replied" }),
    ]);
  });

  it("filters by workspace, honors missing cursors, and caps results", () => {
    const events = new ReviewEventService();
    events.emit({
      workspaceId: "wks_a",
      pageId: null,
      type: "page.created",
      actorUserId: null,
      payload: {},
    });
    events.emit({
      workspaceId: "wks_b",
      pageId: "pg_b",
      type: "page.updated",
      actorUserId: "usr_b",
      payload: {},
    });
    events.emit({
      workspaceId: "wks_a",
      pageId: "pg_a",
      type: "comment.created",
      actorUserId: "usr_a",
      payload: {},
    });

    expect(events.list({ workspaceId: "wks_a", limit: 1 })).toEqual([
      expect.objectContaining({ type: "comment.created" }),
    ]);
    expect(events.list({ pageId: "pg_b" })).toEqual([
      expect.objectContaining({ workspaceId: "wks_b" }),
    ]);
    expect(events.list({ afterId: "evt_missing" })).toHaveLength(3);
  });
});

describe("publication service", () => {
  it("upserts canonical page and folder publications", async () => {
    const publications = new PublicationService();
    const created = await publications.upsert({
      resourceType: "page",
      resourceId: "pg_test",
      workspaceId: "wks_test",
      permission: "comment",
      password: "secretpass",
    });

    expect(created.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(
      publications.verifyPassword(created.id, "wrongpass"),
    ).rejects.toBeInstanceOf(AppError);

    const verified = await publications.verifyPassword(
      created.id,
      "secretpass",
    );
    expect(verified.permission).toBe("comment");
    expect(publications.listUsableForResource("page", "pg_test")).toHaveLength(
      1,
    );

    const updated = await publications.update(created.id, {
      permission: "edit",
      password: null,
      indexingEnabled: true,
    });
    expect(updated.permission).toBe("edit");
    expect(updated.indexingEnabled).toBe(true);
    const folderPublication = await publications.upsert({
      resourceType: "folder",
      resourceId: "fld_test",
      workspaceId: "wks_test",
      permission: "view",
    });
    expect(publications.findForResource("folder", "fld_test")?.id).toBe(
      folderPublication.id,
    );
    expect(publications.revoke(created.id).revokedAt).not.toBeNull();
    expect(publications.listUsableForResource("page", "pg_test")).toHaveLength(
      0,
    );
  });

  it("rejects expired, revoked, and missing publications", async () => {
    const publications = new PublicationService();
    const expired = await publications.upsert({
      resourceType: "page",
      resourceId: "pg_test",
      workspaceId: "wks_test",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(
      publications.verifyPassword(expired.id),
    ).rejects.toBeInstanceOf(AppError);

    const active = await publications.upsert({
      resourceType: "page",
      resourceId: "pg_test",
      workspaceId: "wks_test",
    });
    expect(publications.get(active.id)?.id).toBe(active.id);
    expect(publications.get("missing")).toBeNull();
    publications.revoke(active.id);
    await expect(publications.verifyPassword(active.id)).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(
      publications.update(active.id, { permission: "comment" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(() => publications.revoke("missing")).toThrow(AppError);
  });

  it("supports password checks and filters usable resource grants", async () => {
    const publications = new PublicationService();
    const protectedPublication = await publications.upsert({
      resourceType: "page",
      resourceId: "pg_test",
      workspaceId: "wks_test",
      password: "secretpass",
    });
    const expired = await publications.upsert({
      resourceType: "folder",
      resourceId: "fld_test",
      workspaceId: "wks_test",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const unprotected = await publications.upsert({
      resourceType: "page",
      resourceId: "pg_public",
      workspaceId: "wks_test",
      permission: "edit",
      indexingEnabled: true,
    });

    await expect(
      publications.verifyPassword(protectedPublication.id, "wrong"),
    ).rejects.toBeInstanceOf(AppError);
    expect(
      (
        await publications.verifyPassword(protectedPublication.id, undefined, {
          passwordVerified: true,
        })
      ).id,
    ).toBe(protectedPublication.id);

    const usable = publications.listUsableForResource("page", "pg_public");
    expect(usable.map((publication) => publication.id)).toContain(
      unprotected.id,
    );
    expect(
      publications.listUsableForResource("folder", "fld_test").map((p) => p.id),
    ).not.toContain(expired.id);
    expect(publications.listUsableForResource("page", "missing")).toEqual([]);
  });
});

describe("search service", () => {
  it("returns workspace-scoped search results", () => {
    const search = new SearchService();
    search.index({
      id: "pg_1",
      type: "page",
      pageId: "pg_1",
      workspaceId: "wks_1",
      title: "API Review",
      path: "Product/API Review",
      headingsText: "Overview",
      frontmatterText: "type: spec",
      bodyText: "Agent review workflow",
      tags: "",
      url: "/p/api-review-a",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });
    search.index({
      id: "pg_2",
      type: "page",
      pageId: "pg_2",
      workspaceId: "wks_2",
      title: "API Review",
      path: "Private/API Review",
      headingsText: "",
      frontmatterText: "",
      bodyText: "Do not leak",
      tags: "",
      url: "/p/private-b",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });

    expect(search.search("wks_1", "agent")).toEqual([
      expect.objectContaining({ pageId: "pg_1", title: "API Review" }),
    ]);
    expect(search.search("wks_1", "")).toEqual([]);
    expect(search.search("wks_1", "overview", 1)).toHaveLength(1);
    expect(search.search("wks_1", "not-present")).toEqual([]);
  });

  it("orders matches and falls back to a safe snippet for metadata-only hits", () => {
    const search = new SearchService();
    search.index({
      id: "pg_b",
      type: "page",
      pageId: "pg_b",
      workspaceId: "wks_1",
      title: "Beta",
      path: "Specs",
      headingsText: "",
      frontmatterText: "owner: agent",
      bodyText: "No direct term here",
      tags: "",
      url: "/p/beta",
      updatedAt: "2025-01-03T00:00:00.000Z",
    });
    search.index({
      id: "pg_a",
      type: "page",
      pageId: "pg_a",
      workspaceId: "wks_1",
      title: "Alpha",
      path: "Specs",
      headingsText: "",
      frontmatterText: "owner: agent",
      bodyText: "No direct term here",
      tags: "",
      url: "/p/alpha",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });

    const results = search.search("wks_1", "owner", 10);

    expect(results.map((result) => result.pageId)).toEqual(["pg_b", "pg_a"]);
    expect(results[0]?.snippet).toBe("Beta  No direct term here");
  });

  it("returns mixed resource results with fuzzy matching", () => {
    const search = new SearchService();
    search.index({
      id: "fld_1",
      type: "folder",
      workspaceId: "wks_1",
      folderId: "fld_1",
      title: "Guides",
      path: "guides",
      bodyText: "",
      commentText: "",
      tags: "folder",
      url: "/app/settings/folders?folder_id=fld_1",
      updatedAt: "2025-01-03T00:00:00.000Z",
    });
    search.index({
      id: "cmt_1",
      type: "comment_thread",
      workspaceId: "wks_1",
      pageId: "pg_1",
      title: "Comment on API Review",
      path: "guides/API Review",
      bodyText: "selected paragraph",
      commentText: "Reviewer asked for rollout details",
      tags: "comment thread open",
      url: "/p/api-review?thread_id=cmt_1",
      updatedAt: "2025-01-04T00:00:00.000Z",
    });

    expect(search.search("wks_1", "guids", 10)[0]).toEqual(
      expect.objectContaining({ type: "folder", id: "fld_1" }),
    );
    expect(search.search("wks_1", "rollout", 10)[0]).toEqual(
      expect.objectContaining({
        type: "comment_thread",
        id: "cmt_1",
        matchedField: "comment",
      }),
    );
  });

  it("removes indexed documents and boosts favorites and recently opened resources", () => {
    const search = new SearchService();
    const older = {
      id: "pg_old",
      type: "page" as const,
      workspaceId: "wks_1",
      pageId: "pg_old",
      title: "Runbook",
      path: "Docs",
      bodyText: "shared query term",
      url: "/p/old",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const newer = {
      ...older,
      id: "pg_new",
      pageId: "pg_new",
      url: "/p/new",
      updatedAt: "2025-01-02T00:00:00.000Z",
    };
    search.index(older);
    search.index(newer);

    expect(
      search
        .search("wks_1", "query", {
          favoritePageIds: new Set(["pg_old"]),
          recentResourceIds: new Set(["page:pg_old"]),
        })
        .map((result) => result.pageId),
    ).toEqual(["pg_old", "pg_new"]);

    search.remove("page", "pg_old");
    expect(
      search.search("wks_1", "query").map((result) => result.pageId),
    ).toEqual(["pg_new"]);
  });
});

describe("workspace and permission services", () => {
  it("creates workspace trees and resolves inherited grants", () => {
    const workspaces = new WorkspaceService();
    const permissions = new PermissionService();
    const admin = workspaces.createUser({
      id: "usr_admin",
      email: "admin@example.com",
      displayName: "Admin",
      role: "instance_admin",
    });
    const editor = workspaces.createUser({
      id: "usr_editor",
      email: "ed@example.com",
      displayName: "Editor",
    });
    const workspace = workspaces.createWorkspace({
      id: "wks_test",
      name: "Acme Docs",
    });
    workspaces.addMember({
      workspaceId: workspace.id,
      userId: editor.id,
      role: "editor",
    });
    expect(workspaces.getUserByEmail("ED@example.com")?.id).toBe(editor.id);
    expect(workspaces.listMembers(workspace.id)).toHaveLength(1);
    const agents = workspaces.createFolder({
      id: "fld_agents",
      workspaceId: workspace.id,
      name: "Agents",
    });
    const privateFolder = workspaces.createFolder({
      id: "fld_private",
      workspaceId: workspace.id,
      parentFolderId: agents.id,
      name: "Private",
    });

    expect(privateFolder.path).toBe("agents/private");
    expect(
      workspaces.folderAncestors(privateFolder.id).map((folder) => folder.id),
    ).toEqual(["fld_agents", "fld_private"]);

    permissions.setGrant({
      workspaceId: workspace.id,
      subjectId: editor.id,
      scope: "folder",
      targetId: privateFolder.id,
      level: "none",
    });

    expect(
      permissions.resolve({
        user: editor,
        member: workspaces.getMember(workspace.id, editor.id),
        workspaceId: workspace.id,
        folderAncestorIds: workspaces
          .folderAncestors(privateFolder.id)
          .map((folder) => folder.id),
        pageId: "pg_private",
      }),
    ).toBe("none");
    expect(
      permissions.resolve({
        user: admin,
        workspaceId: workspace.id,
        folderAncestorIds: [privateFolder.id],
        pageId: "pg_private",
      }),
    ).toBe("admin");

    const tree = workspaces.tree({
      workspaceId: workspace.id,
      pages: [
        {
          id: "pg_private",
          folderPath: privateFolder.path,
          title: "Secret",
          slugId: "secret-abc123",
        },
      ],
    });
    expect(tree.folders).toHaveLength(2);
    expect(tree.pages[0]?.folderPath).toBe("agents/private");

    const updated = workspaces.updateFolder({
      folderId: agents.id,
      name: "Guides",
      position: 2,
    });
    expect(updated.previous.path).toBe("agents");
    expect(updated.folder.path).toBe("guides");
    expect(workspaces.getFolder(privateFolder.id)?.path).toBe("guides/private");
    expect(() => workspaces.deleteFolder(updated.folder.id)).toThrow(AppError);
    expect(workspaces.deleteFolder(privateFolder.id).id).toBe(privateFolder.id);
  });

  it("updates workspaces, members, and folders with validation", () => {
    const service = new WorkspaceService();
    const owner = service.createUser({
      id: "usr_owner",
      email: "owner@example.com",
      displayName: "Owner",
    });
    const other = service.createUser({
      id: "usr_other",
      email: "other@example.com",
      displayName: "Other",
    });
    const first = service.createWorkspace({ id: "wks_one", name: "One" });
    const second = service.createWorkspace({ id: "wks_two", name: "Two" });

    expect(
      service.createUser({ email: "OWNER@example.com", displayName: "Again" })
        .id,
    ).toBe(owner.id);
    expect(() =>
      service.createUser({ email: "bad", displayName: "Bad" }),
    ).toThrow(AppError);
    expect(() => service.createWorkspace({ name: "Two" })).toThrow(AppError);

    const renamed = service.updateWorkspace({
      workspaceId: first.id,
      name: "One Docs",
      slug: "one-docs",
    });
    expect(renamed.slug).toBe("one-docs");
    expect(() =>
      service.updateWorkspace({ workspaceId: first.id, slug: second.slug }),
    ).toThrow(AppError);
    expect(() =>
      service.updateWorkspace({ workspaceId: "missing", name: "Nope" }),
    ).toThrow(AppError);
    expect(
      service.updateUser({ userId: owner.id, displayName: "Owner Prime" })
        .displayName,
    ).toBe("Owner Prime");
    expect(() =>
      service.updateUser({ userId: "missing", displayName: "Nope" }),
    ).toThrow(AppError);

    expect(() =>
      service.addMember({
        workspaceId: "missing",
        userId: owner.id,
        role: "reader",
      }),
    ).toThrow(AppError);
    expect(() =>
      service.addMember({
        workspaceId: first.id,
        userId: "missing",
        role: "reader",
      }),
    ).toThrow(AppError);
    const member = service.addMember({
      workspaceId: first.id,
      userId: owner.id,
      role: "reader",
    });
    const updatedMember = service.addMember({
      workspaceId: first.id,
      userId: owner.id,
      role: "admin",
    });
    expect(updatedMember.id).toBe(member.id);
    expect(
      service.updateMemberRole({ memberId: member.id, role: "editor" }).role,
    ).toBe("editor");
    expect(
      service.listWorkspacesForUser(owner.id).map((workspace) => workspace.id),
    ).toEqual([first.id]);
    expect(service.removeMember(member.id).id).toBe(member.id);
    expect(() => service.removeMember(member.id)).toThrow(AppError);

    const root = service.createFolder({
      id: "fld_root",
      workspaceId: first.id,
      name: "Root",
    });
    const child = service.createFolder({
      id: "fld_child",
      workspaceId: first.id,
      parentFolderId: root.id,
      name: "Child",
    });
    const alien = service.createFolder({
      id: "fld_alien",
      workspaceId: second.id,
      name: "Alien",
    });
    expect(() =>
      service.createFolder({
        workspaceId: first.id,
        parentFolderId: alien.id,
        name: "Bad",
      }),
    ).toThrow(AppError);
    expect(() =>
      service.updateFolder({ folderId: root.id, parentFolderId: child.id }),
    ).toThrow(AppError);
    expect(() =>
      service.updateFolder({ folderId: child.id, parentFolderId: alien.id }),
    ).toThrow(AppError);
    expect(
      service.updateFolder({ folderId: child.id, parentFolderId: null }).folder
        .path,
    ).toBe("child");
    expect(service.deleteFolder(child.id).id).toBe(child.id);
    expect(service.deleteFolder(root.id).id).toBe(root.id);
    expect(() => service.tree({ workspaceId: "missing", pages: [] })).toThrow(
      AppError,
    );
    expect(service.getUser(other.id)?.email).toBe("other@example.com");
  });

  it("orders and reorders folders with dense sibling positions", () => {
    const service = new WorkspaceService();
    const workspace = service.createWorkspace({
      id: "wks_order",
      name: "Order",
    });
    const alpha = service.createFolder({
      id: "fld_alpha",
      workspaceId: workspace.id,
      name: "Alpha",
    });
    const bravo = service.createFolder({
      id: "fld_bravo",
      workspaceId: workspace.id,
      name: "Bravo",
    });
    const charlie = service.createFolder({
      id: "fld_charlie",
      workspaceId: workspace.id,
      name: "Charlie",
    });
    const bravoChild = service.createFolder({
      id: "fld_bravo_child",
      workspaceId: workspace.id,
      parentFolderId: bravo.id,
      name: "Child",
    });
    const bravoSecond = service.createFolder({
      id: "fld_bravo_second",
      workspaceId: workspace.id,
      parentFolderId: bravo.id,
      name: "Second",
    });

    expect([alpha.position, bravo.position, charlie.position]).toEqual([
      1, 2, 3,
    ]);
    expect([bravoChild.position, bravoSecond.position]).toEqual([1, 2]);
    expect(
      service.listFolders(workspace.id).map((folder) => folder.id),
    ).toEqual([alpha.id, bravo.id, bravoChild.id, bravoSecond.id, charlie.id]);

    service.reorderFolder({ folderId: charlie.id, direction: "up" });
    expect(
      service
        .listFolders(workspace.id)
        .filter((folder) => !folder.parentFolderId)
        .map((folder) => [folder.id, folder.position]),
    ).toEqual([
      [alpha.id, 1],
      [charlie.id, 2],
      [bravo.id, 3],
    ]);

    service.reorderFolder({ folderId: bravoSecond.id, direction: "up" });
    expect(
      service
        .listFolders(workspace.id)
        .filter((folder) => folder.parentFolderId === bravo.id)
        .map((folder) => [folder.id, folder.position]),
    ).toEqual([
      [bravoSecond.id, 1],
      [bravoChild.id, 2],
    ]);
  });

  it("covers workspace and folder edge cases", () => {
    const service = new WorkspaceService();
    const user = service.createUser({
      id: "usr_edge",
      email: "edge@example.com",
      displayName: "",
    });
    const workspace = service.createWorkspace({
      id: "wks_edge",
      name: "Edge",
    });

    expect(user.displayName).toBe("edge@example.com");
    expect(() =>
      service.updateWorkspace({ workspaceId: workspace.id, name: "   " }),
    ).toThrow(AppError);
    expect(
      service.updateWorkspace({
        workspaceId: workspace.id,
        versionRetentionDays: 14,
      }).versionRetentionDays,
    ).toBe(14);
    expect(() =>
      service.updateMemberRole({ memberId: "missing", role: "reader" }),
    ).toThrow(AppError);
    expect(() =>
      service.createFolder({
        workspaceId: "missing",
        name: "No workspace",
      }),
    ).toThrow(AppError);
    expect(() =>
      service.createFolder({
        workspaceId: workspace.id,
        parentFolderId: "missing",
        name: "No parent",
      }),
    ).toThrow(AppError);
    expect(() =>
      service.createFolder({
        workspaceId: workspace.id,
        name: "   ",
      }),
    ).toThrow(AppError);
    expect(() => service.deleteFolder("missing")).toThrow(AppError);

    const keep = service.tree({
      workspaceId: workspace.id,
      pages: [
        {
          id: "pg_keep",
          folderPath: "",
          title: "Keep",
          slugId: "keep-a8f31c000000",
        },
        {
          id: "pg_drop",
          folderPath: "",
          title: "Drop",
          slugId: "drop-a8f31c000001",
        },
      ],
      visiblePageIds: new Set(["pg_keep"]),
    });
    expect(keep.pages.map((page) => page.id)).toEqual(["pg_keep"]);
  });
});

describe("auth service", () => {
  it("creates single-use magic links and sessions", async () => {
    const auth = new AuthService();
    const link = await auth.createMagicLink({
      email: "Admin@Example.com",
      redirectTo: "/p/get-started-a8f31c000000",
    });

    expect(link.link.email).toBe("admin@example.com");
    expect(link.link.tokenHash).not.toBe(link.rawToken);

    const session = await auth.consumeMagicLink(link.rawToken, "usr_admin");
    expect(auth.getSession(session.id)?.userId).toBe("usr_admin");
    await expect(
      auth.consumeMagicLink(link.rawToken, "usr_admin"),
    ).rejects.toBeInstanceOf(AppError);

    auth.destroySession(session.id);
    expect(auth.getSession(session.id)).toBeNull();

    const directSession = auth.createSession("usr_admin");
    expect(auth.getSession(directSession.id)?.userId).toBe("usr_admin");
  });

  it("only consumes one concurrent magic-link attempt", async () => {
    class YieldingAuthService extends AuthService {
      async verifyMagicLink(rawToken: string) {
        const link = await super.verifyMagicLink(rawToken);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return link;
      }
    }

    const auth = new YieldingAuthService();
    const link = await auth.createMagicLink({
      email: "admin@example.com",
      redirectTo: "/app",
    });

    const results = await Promise.allSettled([
      auth.consumeMagicLink(link.rawToken, "usr_admin"),
      auth.consumeMagicLink(link.rawToken, "usr_admin"),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("normalizes magic link redirects to same-origin paths", async () => {
    const auth = new AuthService();

    const protocolRelative = await auth.createMagicLink({
      email: "admin@example.com",
      redirectTo: "//attacker.example/steal",
    });
    const backslashHost = await auth.createMagicLink({
      email: "admin2@example.com",
      redirectTo: "/\\attacker.example/steal",
    });
    const safePath = await auth.createMagicLink({
      email: "admin3@example.com",
      redirectTo: "/app?tab=pages#top",
    });

    expect(protocolRelative.link.redirectTo).toBe("/");
    expect(backslashHost.link.redirectTo).toBe("/");
    expect(safePath.link.redirectTo).toBe("/app?tab=pages#top");
  });

  it("sanitizes stored magic link redirects during verification", async () => {
    const auth = new AuthService();
    const created = await auth.createMagicLink({
      email: "admin@example.com",
      redirectTo: "/app",
    });
    const internals = auth as unknown as {
      magicLinks: Map<string, { redirectTo: string }>;
    };
    const stored = internals.magicLinks.get(created.link.id);
    if (!stored) throw new Error("Expected stored magic link.");
    stored.redirectTo = "//attacker.example/steal";

    const verified = await auth.verifyMagicLink(created.rawToken);

    expect(verified.redirectTo).toBe("/");
    expect(stored.redirectTo).toBe("/");
  });

  it("rejects expired magic links and expired sessions", async () => {
    const auth = new AuthService();
    const expiredLink = await auth.createMagicLink({
      email: "expired@example.com",
      ttlMinutes: -1,
    });
    await expect(
      auth.verifyMagicLink(expiredLink.rawToken),
    ).rejects.toBeInstanceOf(AppError);

    const session = auth.createSession("usr_expired");
    const internals = auth as unknown as {
      sessions: Map<string, { expiresAt: string }>;
    };
    const stored = internals.sessions.get(session.id);
    if (!stored) throw new Error("Expected stored session.");
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();

    expect(auth.getSession(session.id)).toBeNull();
  });
});

describe("attachment service", () => {
  it("stores private page attachments under the page object path", async () => {
    const objectStore = new InMemoryObjectStore();
    const pages = new PageService(objectStore);
    const attachments = new AttachmentService(objectStore, {
      maxAttachmentBytes: 1024,
    });
    const page = await pages.createPage({
      id: "pg_attach000000000000000000",
      workspaceId: "wks_test",
      folderPath: "Images",
      title: "Image Test",
      sourceType: "markdown",
      source: "# Image",
    });

    const uploaded = await attachments.upload({
      page: page.page,
      filename: "Hero Image.PNG",
      contentType: "image/png",
      base64Body: btoa("png"),
    });

    expect(uploaded.objectKey).toContain("/attachments/");
    expect(uploaded.filename).toBe("hero-image.png");
    expect((await attachments.get(uploaded.id))?.base64Body).toBe(btoa("png"));
    expect(attachments.listForPage(page.page.id)).toEqual([
      expect.objectContaining({ id: uploaded.id }),
    ]);
    expect(await attachments.get("missing")).toBeNull();
    await objectStore.delete(uploaded.objectKey);
    expect(await attachments.get(uploaded.id)).toBeNull();
    await expect(
      attachments.upload({
        page: page.page,
        filename: "huge.txt",
        contentType: "text/plain",
        base64Body: btoa("x".repeat(2000)),
      }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      attachments.upload({
        page: page.page,
        filename: "script.js",
        contentType: "application/javascript",
        base64Body: btoa("alert(1)"),
      }),
    ).rejects.toBeInstanceOf(AppError);

    const svg = await attachments.upload({
      page: page.page,
      filename: "chart.svg",
      contentType: "image/svg+xml",
      base64Body: btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a></svg>',
      ),
    });
    const storedSvg = atob((await attachments.get(svg.id))?.base64Body ?? "");
    expect(storedSvg).toContain("<svg");
    expect(storedSvg).not.toContain("<script");
    expect(storedSvg).not.toContain("onload");
    expect(storedSvg).not.toContain("javascript:");
  });
});

describe("object stores", () => {
  it("supports in-memory list, get, put, and delete", async () => {
    const store = new InMemoryObjectStore();
    await store.put("pages/a.md", "# A", { contentType: "text/markdown" });
    await store.put("assets/a.png", "png", { contentType: "image/png" });
    expect(await store.get("pages/a.md")).toEqual(
      expect.objectContaining({ body: "# A", contentType: "text/markdown" }),
    );
    expect(await store.list("pages/")).toHaveLength(1);
    await store.delete("pages/a.md");
    expect(await store.get("pages/a.md")).toBeNull();
  });

  it("wraps R2-compatible buckets", async () => {
    const uploaded = new Date("2026-05-11T00:00:00.000Z");
    const objects = new Map<
      string,
      { body: string; contentType?: string; uploaded?: Date }
    >();
    const store = new R2ObjectStore({
      async get(key) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          text: async () => object.body,
          httpMetadata: { contentType: object.contentType },
          uploaded: object.uploaded,
        };
      },
      async put(key, value, options) {
        const body =
          typeof value === "string"
            ? value
            : new TextDecoder().decode(value as ArrayBuffer | Uint8Array);
        objects.set(key, {
          body,
          contentType: options?.httpMetadata?.contentType,
          uploaded,
        });
        return { uploaded };
      },
      async delete(key) {
        objects.delete(key);
      },
      async list(options) {
        return {
          objects: [...objects.keys()]
            .filter((key) => key.startsWith(options?.prefix ?? ""))
            .map((key) => ({
              key,
              uploaded: objects.get(key)?.uploaded,
              httpMetadata: { contentType: objects.get(key)?.contentType },
            })),
        };
      },
    });

    const written = await store.put("docs/a.md", "# A", {
      contentType: "text/markdown",
    });
    expect(written.updatedAt).toBe(uploaded.toISOString());
    expect(await store.get("docs/a.md")).toEqual(
      expect.objectContaining({ body: "# A" }),
    );
    expect(await store.list("docs/")).toEqual([
      expect.objectContaining({ key: "docs/a.md" }),
    ]);
    await store.delete("docs/a.md");
    expect(await store.get("docs/a.md")).toBeNull();
  });

  it("falls back when R2 list metadata exists but object bodies are missing", async () => {
    const uploaded = new Date("2026-05-11T00:00:00.000Z");
    const store = new R2ObjectStore({
      async get() {
        return null;
      },
      async put() {
        return null;
      },
      async delete() {},
      async list() {
        return {
          objects: [
            {
              key: "docs/missing.md",
              uploaded,
              httpMetadata: { contentType: "text/markdown" },
            },
            {
              key: "docs/no-date.md",
            },
          ],
        };
      },
    });

    const written = await store.put("docs/new.md", "# New");
    expect(written.body).toBe("# New");
    expect(written.updatedAt).toMatch(/T/);
    expect(await store.list("docs/")).toEqual([
      expect.objectContaining({
        key: "docs/missing.md",
        body: "",
        contentType: "text/markdown",
        updatedAt: uploaded.toISOString(),
      }),
      expect.objectContaining({ key: "docs/no-date.md", body: "" }),
    ]);
  });
});

describe("audit service", () => {
  it("records scoped audit events", () => {
    const audit = new AuditService();
    const first = audit.record({
      workspaceId: "wks_test",
      actorUserId: "usr_admin",
      action: "page.created",
      targetType: "page",
      targetId: "pg_test",
      metadata: { title: "Plan" },
    });
    audit.record({
      workspaceId: "wks_other",
      actorUserId: null,
      action: "workspace.created",
      targetType: "workspace",
      targetId: "wks_other",
      metadata: {},
    });
    audit.record({
      workspaceId: "wks_test",
      actorUserId: "usr_admin",
      action: "page.updated",
      targetType: "page",
      targetId: "pg_test",
      metadata: {},
    });

    expect(audit.list({ workspaceId: "wks_test" })).toEqual([
      expect.objectContaining({
        action: "page.created",
        metadata: { title: "Plan" },
      }),
      expect.objectContaining({
        action: "page.updated",
      }),
    ]);
    expect(
      audit.list({ workspaceId: "wks_test", afterId: first.id, limit: 1 }),
    ).toEqual([expect.objectContaining({ action: "page.updated" })]);
  });
});
