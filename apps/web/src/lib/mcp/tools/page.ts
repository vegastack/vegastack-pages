import { AppError } from "@vegastack/pages-core";
import {
  audit,
  folders,
  pages,
  reviewEvents,
  search,
  templates,
} from "@vegastack/pages-services";
import {
  absoluteUrl,
  asString,
  pageMutationResult,
  requiredWorkspaceId,
} from "../util";
import { assertWorkspacePermission, getExistingPage } from "../permissions";
import {
  assertEditBase,
  patchSource,
  resolveTemplate,
  updatePageSource,
} from "../shared";
import type { McpToolContext } from "../types";

export async function createPage(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "write");

  // template_id branch: render the template into Markdown + create the page.
  // If the caller ALSO provides a non-empty `source`, that wins for the body
  // (the template render is only used to seed properties/source_type). This
  // matches caller intent: when an agent has already drafted the prose, the
  // template should not silently overwrite it. To force a fresh template
  // render, omit `source` (or pass an empty string).
  const templateIdentifier =
    args.template_id !== undefined
      ? String(args.template_id)
      : args.template !== undefined
        ? String(args.template)
        : "";
  const callerSource =
    typeof args.source === "string" && args.source.length > 0
      ? args.source
      : "";

  if (templateIdentifier) {
    const template = await resolveTemplate(
      context,
      workspaceId,
      templateIdentifier,
    );
    const title = asString(args.title).trim();
    if (!title) {
      throw new AppError(
        "VALIDATION_ERROR",
        "title is required and must be a non-empty string.",
        400,
      );
    }
    const properties =
      args.properties && typeof args.properties === "object"
        ? (args.properties as Record<string, unknown>)
        : {};
    const rendered = await templates.render(ctx, {
      templateId: template.id,
      values: { title, ...properties },
    });
    const body = callerSource !== "" ? callerSource : rendered.body;
    const sourceType =
      args.source_type === "mdx" || args.source_type === "html"
        ? args.source_type
        : rendered.sourceType === "mdx"
          ? "mdx"
          : "markdown";
    const created = await pages.create(ctx, {
      workspaceId,
      folderPath: args.folder_path ? String(args.folder_path) : "",
      title,
      sourceType,
      source: body,
    });
    ctx.waitUntil(search.scheduleIndexPage(ctx, created.data.page.id));
    await audit.record(ctx, {
      workspaceId: created.data.page.workspaceId,
      actorUserId: context.actor.user?.id ?? null,
      action: "page.created_from_template",
      targetType: "page",
      targetId: created.data.page.id,
      metadata: {
        template_id: template.id,
        template_slug: template.slug,
        title: created.data.page.title,
        folder_path: created.data.page.folderPath,
        source: "mcp",
      },
    });
    await reviewEvents.emit(ctx, {
      workspaceId: created.data.page.workspaceId,
      pageId: created.data.page.id,
      type: "page.created",
      actorUserId: context.actor.user?.id ?? null,
      payload: {
        page_id: created.data.page.id,
        version_id: created.data.page.versionId,
        template_slug: template.slug,
        source: "mcp",
      },
    });
    return pageMutationResult(created.data.page, context);
  }

  // Title is required; the row's title field is what every surface
  // displays. The service layer would silently fall back to "Untitled"
  // — better to surface the gap to the caller.
  const titleArg = asString(args.title).trim();
  if (!titleArg) {
    throw new AppError(
      "VALIDATION_ERROR",
      "title is required and must be a non-empty string.",
      400,
    );
  }
  const created = await pages.create(ctx, {
    workspaceId,
    folderPath: args.folder_path ? String(args.folder_path) : "",
    title: titleArg,
    sourceType:
      args.source_type === "mdx" || args.source_type === "html"
        ? args.source_type
        : "markdown",
    source: asString(args.source, ""),
  });
  ctx.waitUntil(search.scheduleIndexPage(ctx, created.data.page.id));
  await reviewEvents.emit(ctx, {
    workspaceId: created.data.page.workspaceId,
    pageId: created.data.page.id,
    type: "page.created",
    actorUserId: null,
    payload: {
      page_id: created.data.page.id,
      version_id: created.data.page.versionId,
      source: "mcp",
    },
  });
  return pageMutationResult(created.data.page, context);
}

// update_page has three modes (mutually exclusive):
//   - full source replace: pass `source`
//   - find/replace patch:  pass `find` (+ optional `replace`, `replace_all`,
//                            `expected_replacements`)
//   - checkpoint-only:     pass `checkpoint: true` with no `source` / `find`
// All three require `base_version_id` for optimistic concurrency.
export async function updatePage(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    "write",
    args.workspace_id,
  );
  assertEditBase(page.page, args);

  const hasFind = typeof args.find === "string" && args.find.length > 0;
  const hasSource = typeof args.source === "string";
  const checkpointOnly = Boolean(args.checkpoint) && !hasSource && !hasFind;

  // Reject mode-conflict combinations explicitly. The previous behavior
  // silently picked find/replace when both `source` and `find` were
  // provided, dropping the caller's source. (Audit cycle 5 finding.)
  if (hasFind && hasSource) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Pass either `source` (full replace) or `find`/`replace` (patch), not both.",
      400,
    );
  }

  if (checkpointOnly) {
    const ctx = context.ctx;
    const updated = await pages.updateSource(ctx, {
      pageId: page.page.id,
      source: page.source,
      baseVersionId: page.page.versionId,
      checkpoint: true,
      checkpointLabel: args.checkpoint_label
        ? String(args.checkpoint_label)
        : "Manual snapshot",
    });
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "page.version_created",
      actorUserId: context.actor.user?.id ?? null,
      payload: {
        version_id: updated.data.page.versionId,
        label: args.checkpoint_label ?? null,
        source: "mcp",
      },
    });
    return {
      page_id: updated.data.page.id,
      slug_id: updated.data.page.slugId,
      url: absoluteUrl(context, `/p/${updated.data.page.slugId}`),
      version_id: updated.data.page.versionId,
      content_hash: updated.data.page.contentHash,
      updated_at: updated.data.page.updatedAt,
      checkpoint_created: updated.data.checkpointCreated,
      changed: updated.data.changed,
    };
  }

  if (hasFind) {
    const patched = patchSource(page.source, args);
    const updated = await updatePageSource(context, {
      pageId: page.page.id,
      source: patched.source,
      baseVersionId: page.page.versionId,
      checkpoint: Boolean(args.checkpoint),
      checkpointLabel: args.checkpoint_label
        ? String(args.checkpoint_label)
        : null,
    });
    return {
      ...updated,
      replacement_count: patched.replacementCount,
    };
  }

  // Full source replace
  const source = asString(args.source, "");
  if (!Boolean(args.allow_noop) && source === page.source) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Page source is unchanged. Pass allow_noop=true to save anyway.",
      400,
      {
        current_version_id: page.page.versionId,
        current_content_hash: page.page.contentHash,
      },
    );
  }
  return updatePageSource(context, {
    pageId: page.page.id,
    source,
    baseVersionId: page.page.versionId,
    checkpoint: Boolean(args.checkpoint),
    checkpointLabel: args.checkpoint_label
      ? String(args.checkpoint_label)
      : null,
  });
}

export async function restorePageVersion(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    "write",
    args.workspace_id,
  );
  const versionId = asString(args.version_id);
  if (!versionId) {
    throw new AppError("VALIDATION_ERROR", "version_id is required.", 400);
  }
  const version = await pages.getVersionSource(ctx, {
    pageId: page.page.id,
    versionId,
  });
  const restored = await updatePageSource(context, {
    pageId: page.page.id,
    source: version.source,
    baseVersionId: page.page.versionId,
    checkpoint: true,
    checkpointLabel: `Restored ${version.version.createdAt}`,
  });
  await audit.record(ctx, {
    workspaceId: page.page.workspaceId,
    actorUserId: context.actor.user?.id ?? null,
    action: "page.version_restored",
    targetType: "page",
    targetId: page.page.id,
    metadata: {
      version_id: versionId,
      restored_version_id: restored.version_id,
    },
  });
  return restored;
}

export async function movePage(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    "write",
    args.workspace_id,
  );
  const folderPath =
    args.folder_path === undefined
      ? undefined
      : String(args.folder_path).replace(/^\/+|\/+$/g, "");
  const titleProvided = args.title !== undefined;
  if (!titleProvided && args.folder_path === undefined) {
    throw new AppError(
      "VALIDATION_ERROR",
      "move_page requires at least one of `title` or `folder_path`.",
      400,
    );
  }
  if (folderPath) {
    const allFolders = await folders.listAll(ctx, {
      workspaceId: page.page.workspaceId,
    });
    const normalized = `/${folderPath}`;
    if (!allFolders.some((folder) => folder.path === normalized)) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Folder was not found in this workspace.",
        404,
      );
    }
  }
  const moved = await pages.move(ctx, {
    pageId: asString(args.page_id),
    title: args.title === undefined ? undefined : String(args.title),
    folderPath,
  });
  const updated = moved.data;
  ctx.waitUntil(search.scheduleIndexPage(ctx, updated.id));
  await reviewEvents.emit(ctx, {
    workspaceId: updated.workspaceId,
    pageId: updated.id,
    type: "page.moved",
    actorUserId: null,
    payload: {
      page_id: updated.id,
      title: updated.title,
      folder_path: updated.folderPath,
      source: "mcp",
    },
  });
  return {
    page: updated,
    url: absoluteUrl(context, `/p/${updated.slugId}`),
  };
}

// Soft-delete (move to trash). The page row stays in D1 with
// `deleted_at` set; restorable via restore_page within 30 days, then
// the auto-purge cron hard-deletes. Pass `permanent: true` to skip
// trash and hard-delete immediately (admin-only). Trashed pages stop
// showing up in fetch/search/list responses for everyone.
export async function deletePage(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const permanent = Boolean(args.permanent);
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    permanent ? "admin" : "write",
    args.workspace_id,
  );
  if (permanent) {
    // hardDelete requires the page to already be soft-deleted. Walk
    // through the trash if the caller asks for immediate purge.
    if (!page.page.deletedAt) {
      await pages.softDelete(ctx, page.page.id);
    }
    const result = await pages.hardDelete(ctx, page.page.id);
    await audit.record(ctx, {
      workspaceId: result.workspaceId,
      actorUserId: context.actor.user?.id ?? null,
      action: "page.hard_deleted",
      targetType: "page",
      targetId: result.pageId,
      metadata: { title: page.page.title, source: "mcp" },
    });
    return { ok: true, page_id: result.pageId, permanent: true };
  }
  const deleted = await pages.softDelete(ctx, page.page.id);
  await audit.record(ctx, {
    workspaceId: deleted.data.workspaceId,
    actorUserId: context.actor.user?.id ?? null,
    action: "page.soft_deleted",
    targetType: "page",
    targetId: deleted.data.id,
    metadata: { title: page.page.title, source: "mcp" },
  });
  await reviewEvents.emit(ctx, {
    workspaceId: deleted.data.workspaceId,
    pageId: deleted.data.id,
    type: "page.deleted",
    actorUserId: context.actor.user?.id ?? null,
    payload: {
      page_id: deleted.data.id,
      title: deleted.data.title,
      source: "mcp",
    },
  });
  return {
    ok: true,
    page_id: deleted.data.id,
    deleted_at: deleted.data.deletedAt,
    permanent: false,
  };
}

// Restore a soft-deleted page. Editor+ on the workspace.
export async function restorePage(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const pageId = asString(args.page_id);
  const existing = await pages.get(ctx, pageId, { includeDeleted: true });
  if (!existing) {
    throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
  }
  if (!existing.page.deletedAt) {
    throw new AppError("VALIDATION_ERROR", "Page is not in the trash.", 400);
  }
  await assertWorkspacePermission(context, existing.page.workspaceId, "write");
  const restored = await pages.restore(ctx, pageId);
  await audit.record(ctx, {
    workspaceId: restored.data.workspaceId,
    actorUserId: context.actor.user?.id ?? null,
    action: "page.restored",
    targetType: "page",
    targetId: restored.data.id,
    metadata: { title: restored.data.title, source: "mcp" },
  });
  await reviewEvents.emit(ctx, {
    workspaceId: restored.data.workspaceId,
    pageId: restored.data.id,
    type: "page.restored",
    actorUserId: context.actor.user?.id ?? null,
    payload: {
      page_id: restored.data.id,
      title: restored.data.title,
      source: "mcp",
    },
  });
  return { ok: true, page: restored.data };
}

// List trashed pages in a workspace. scope=mine returns just the
// pages the caller deleted; scope=workspace returns all (editor+).
export async function listTrash(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const workspaceId = String(args.workspace_id ?? "");
  if (!workspaceId) {
    throw new AppError("WORKSPACE_REQUIRED", "workspace_id is required.", 400);
  }
  const scope: "mine" | "workspace" =
    args.scope === "workspace" ? "workspace" : "mine";
  await assertWorkspacePermission(
    context,
    workspaceId,
    scope === "workspace" ? "write" : "read",
  );
  const items = await pages.listTrashed(ctx, {
    workspaceId,
    scope,
    userId: context.actor.user?.id ?? null,
  });
  return {
    scope,
    items: items.map((entry) => ({
      page_id: entry.pageId,
      title: entry.title,
      folder_path: entry.folderPath,
      slug_id: entry.slugId,
      source_type: entry.sourceType,
      deleted_at: entry.deletedAt,
      deleted_by_user_id: entry.deletedByUserId,
    })),
  };
}
