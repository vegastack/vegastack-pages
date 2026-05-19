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
  const templateIdentifier =
    args.template_id !== undefined
      ? String(args.template_id)
      : args.template !== undefined
        ? String(args.template)
        : "";

  if (templateIdentifier) {
    const template = await resolveTemplate(
      context,
      workspaceId,
      templateIdentifier,
    );
    const title = asString(args.title);
    const properties =
      args.properties && typeof args.properties === "object"
        ? (args.properties as Record<string, unknown>)
        : {};
    const rendered = await templates.render(ctx, {
      templateId: template.id,
      values: { title, ...properties },
    });
    const created = await pages.create(ctx, {
      workspaceId,
      folderPath: args.folder_path ? String(args.folder_path) : "",
      title,
      sourceType: rendered.sourceType === "mdx" ? "mdx" : "markdown",
      source: rendered.body,
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

  const created = await pages.create(ctx, {
    workspaceId,
    folderPath: args.folder_path ? String(args.folder_path) : "",
    title: asString(args.title, "Untitled"),
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
