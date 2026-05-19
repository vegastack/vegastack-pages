import { AppError, templateBuilderFromMarkdown } from "@vegastack/pages-core";
import { flattenFrontmatter, renderAtSave } from "@vegastack/pages-renderer";
import {
  pages,
  publications,
  reviewEvents,
  templates,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { serializePublication } from "../../publication-api";
import {
  buildWorkspaceNavigation,
  filterWorkspaceNavigation,
} from "../../workspace-navigation";
import {
  absoluteUrl,
  asString,
  clampNumber,
  requiredWorkspaceId,
} from "../util";
import {
  assertPagePermission,
  assertWorkspacePermission,
  getExistingFolder,
  getExistingPage,
  getThreadPage,
} from "../permissions";
import {
  listPageComments,
  resolveTemplate,
  serializeMcpTemplate,
} from "../shared";
import { whoami, listWorkspacesForUser } from "./whoami";
import type { McpToolContext } from "../types";

const allowedIncludes = new Set([
  "metadata",
  "source",
  "rendered",
  "versions",
  "comments",
  "publication",
  "edit_tokens",
  "members",
  "properties",
  "history",
  "review_events",
  "workspaces",
  "templates",
  "tree",
]);

function normalizeInclude(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const include = new Set(
    values
      .map((item) => String(item).trim())
      .filter((item) => allowedIncludes.has(item)),
  );
  include.add("metadata");
  return include;
}

export async function fetchResource(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const resourceId = asString(args.resource_id, "").trim();
  const include = normalizeInclude(args.include);

  // 'me' — mirrors whoami plus optional workspaces include
  if (resourceId === "me") {
    return whoami(args, context);
  }

  // No resource_id: workspace-level listings (workspaces, tree, templates)
  if (!resourceId) {
    return fetchWorkspaceLevel(args, context, include);
  }

  if (resourceId.startsWith("pg_")) {
    return fetchPage(args, context, include);
  }
  if (resourceId.startsWith("fld_")) {
    return fetchFolder(args, context, include);
  }
  if (resourceId.startsWith("tpl_")) {
    return fetchTemplate(args, context, resourceId);
  }
  if (resourceId.startsWith("thr_")) {
    return fetchThread(args, context);
  }
  if (resourceId.startsWith("pub_")) {
    return fetchPublication(args, context);
  }
  if (resourceId.startsWith("wks_")) {
    return fetchWorkspace(args, context, include);
  }

  // Looks like a typed prefix (3-5 lowercase letters + underscore) but
  // isn't one we recognize → fail loud instead of silently falling
  // through to slug lookup. That fallback used to mask typos like
  // `tmp_xyz` as cryptic page-not-found errors. (Audit cycle 5.)
  if (/^[a-z]{2,5}_/.test(resourceId)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Unknown resource_id prefix. Expected pg_, fld_, tpl_, thr_, pub_, wks_, or 'me'.",
      400,
      { resource_id: resourceId },
    );
  }
  // No typed prefix → treat as a page slug-id (e.g. "smoke-test-kangaroo-3b59…").
  return fetchPage(args, context, include);
}

function resourceIdHasKnownPrefix(resourceId: string) {
  return (
    resourceId.startsWith("pg_") ||
    resourceId.startsWith("fld_") ||
    resourceId.startsWith("tpl_") ||
    resourceId.startsWith("thr_") ||
    resourceId.startsWith("pub_") ||
    resourceId.startsWith("wks_")
  );
}

async function fetchWorkspaceLevel(
  args: Record<string, unknown>,
  context: McpToolContext,
  include: Set<string>,
) {
  // include=['workspaces'] without a workspace_id → user-wide workspace list.
  if (include.has("workspaces") && !args.workspace_id) {
    const list = await listWorkspacesForUser(context);
    return { workspaces: list };
  }
  return fetchWorkspace(args, context, include);
}

async function fetchWorkspace(
  args: Record<string, unknown>,
  context: McpToolContext,
  include: Set<string>,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "read");
  const result: Record<string, unknown> = { workspace_id: workspaceId };

  if (include.has("workspaces")) {
    result.workspaces = await listWorkspacesForUser(context);
  }

  if (include.has("templates")) {
    const category = args.category ? String(args.category) : null;
    const all = await templates.listForWorkspace(ctx, { workspaceId });
    result.templates = all
      .filter((template) => !category || template.category === category)
      .map((template) => ({
        id: template.id,
        slug: template.slug,
        name: template.name,
        description: template.description,
        category: template.category,
        source_type: template.sourceType,
        properties: template.properties,
        is_builtin: template.isBuiltin,
      }));
  }

  if (include.has("members")) {
    const memberRows = await workspaces.listMembers(ctx, { workspaceId });
    result.members = await Promise.all(
      memberRows.map(async (m) => {
        const user = await users.getById(ctx, m.userId).catch(() => null);
        return {
          id: m.id,
          user_id: m.userId,
          email: user?.email ?? null,
          display_name: user?.displayName ?? null,
          role: m.role,
          created_at: m.createdAt,
        };
      }),
    );
  }

  if (include.has("review_events")) {
    if (args.page_id) {
      await getExistingPage(context, String(args.page_id), "read", workspaceId);
    }
    result.events = await reviewEvents.list(ctx, {
      workspaceId,
      pageId: args.page_id ? String(args.page_id) : undefined,
      afterId: args.after_id ? String(args.after_id) : undefined,
      limit: clampNumber(args.limit, 50, 1, 200),
    });
  }

  // Tree is the default for workspace fetches (mirrors the old list_workspace).
  if (
    include.has("tree") ||
    (!include.has("templates") &&
      !include.has("workspaces") &&
      !include.has("members") &&
      !include.has("review_events"))
  ) {
    const nav = await buildWorkspaceNavigation(
      {
        ...context.actor,
        sessionId: null,
        devFallback: false,
        authMode: "mcp_session",
      },
      workspaceId,
    );
    const depth =
      args.depth === undefined || args.depth === null
        ? null
        : clampNumber(args.depth, 0, 0, 20);
    const folderId = asString(args.folder_id, "");
    const updatedAfter = asString(args.updated_after, "");
    const filtered = filterWorkspaceNavigation(nav, {
      folderId,
      depth,
      updatedAfter,
    });
    if (!filtered) {
      throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
    }
    result.tree_version = nav.treeVersion;
    result.page_count = nav.visiblePages.length;
    result.folder_count = nav.visibleFolders.length;
    result.counts =
      args.include_counts === true
        ? {
            pages: nav.visiblePages.length,
            folders: nav.visibleFolders.length,
          }
        : undefined;
    result.folders = filtered.folders;
    result.pages = filtered.pages.map((page) => ({
      id: page.id,
      folderPath: page.folderPath,
      title: page.title,
      slugId: page.slugId,
      url: absoluteUrl(context, `/p/${page.slugId}`),
    }));
    result.partial = Boolean(folderId || depth || updatedAfter);
  }

  return result;
}

async function fetchPage(
  args: Record<string, unknown>,
  context: McpToolContext,
  include: Set<string>,
) {
  const ctx = context.ctx;
  const page = await getExistingPage(
    context,
    asString(args.resource_id || args.page_id),
    "read",
    args.workspace_id,
  );
  const result: Record<string, unknown> = {
    page: page.page,
    url: absoluteUrl(context, `/p/${page.page.slugId}`),
  };

  const wantsEditTokens = include.has("edit_tokens");
  const wantsSource = include.has("source") || wantsEditTokens;

  if (wantsSource) result.source = page.source;
  if (wantsEditTokens) {
    result.base_version_id = page.page.versionId;
    result.base_content_hash = page.page.contentHash;
    result.update_page_arguments = {
      workspace_id: page.page.workspaceId,
      page_id: page.page.id,
      base_version_id: page.page.versionId,
      base_content_hash: page.page.contentHash,
      source: page.source,
    };
  }
  if (include.has("rendered")) {
    const rendered =
      page.page.sourceType === "html"
        ? { html: "", headings: [], frontmatter: {} }
        : await renderAtSave({
            source: page.source,
            sourceType: page.page.sourceType,
          });
    result.rendered = {
      page_id: page.page.id,
      content_hash: page.page.contentHash,
      source_type: page.page.sourceType,
      html: rendered.html,
      render_mode: page.page.sourceType === "html" ? "sandboxed_html" : "html",
      headings: rendered.headings,
      frontmatter: rendered.frontmatter,
      frontmatter_text: flattenFrontmatter(rendered.frontmatter),
    };
  }
  if (include.has("versions")) {
    const versions = await pages.listVersions(ctx, {
      pageId: page.page.id,
    });
    result.versions = versions.slice(0, 100);
    result.versions_truncated = versions.length > 100;
  }
  if (include.has("comments")) {
    // Audit cycle 5: previously only "resolved" or "all" matched; "open"
    // fell through to "all", silently broadening the result set.
    const statusArg =
      args.status === "resolved" ||
      args.status === "all" ||
      args.status === "open"
        ? args.status
        : "all";
    const threads = await listPageComments(
      context,
      page.page.id,
      statusArg,
      page.page.workspaceId,
    );
    result.threads = threads.slice(0, 100);
    result.threads_truncated = threads.length > 100;
  }
  if (include.has("publication")) {
    await assertPagePermission(context, page.page, "admin");
    result.publication = await serializePublication(ctx, {
      type: "page",
      page: page.page,
      slugId: page.page.slugId,
    });
  }
  if (include.has("review_events")) {
    result.events = await reviewEvents.list(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      afterId: args.after_id ? String(args.after_id) : undefined,
      limit: clampNumber(args.limit, 50, 1, 200),
    });
  }
  return result;
}

async function fetchFolder(
  args: Record<string, unknown>,
  context: McpToolContext,
  _include: Set<string>,
) {
  const folder = await getExistingFolder(
    context,
    asString(args.resource_id),
    "read",
    args.workspace_id,
  );
  return { folder };
}

async function fetchTemplate(
  args: Record<string, unknown>,
  context: McpToolContext,
  resourceId: string,
) {
  const ctx = context.ctx;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  await assertWorkspacePermission(context, workspaceId, "read");
  const template = await resolveTemplate(context, workspaceId, resourceId);
  const withSource = await templates.getWithSource(ctx, template.id);
  if (!withSource) {
    throw new AppError("PAGE_NOT_FOUND", "Template source was not found.", 404);
  }
  return {
    template: {
      ...serializeMcpTemplate(withSource),
      content_hash: withSource.contentHash,
    },
    source: withSource.source,
    builder: templateBuilderFromMarkdown(withSource.source),
  };
}

async function fetchThread(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const { thread, page } = await getThreadPage(
    context,
    asString(args.resource_id),
    "read",
    args.workspace_id,
  );
  const list = await listPageComments(
    context,
    page.page.id,
    "all",
    page.page.workspaceId,
  );
  const entry = list.find((item) => item.thread.id === thread.id);
  return {
    thread: entry?.thread ?? thread,
    anchor: entry?.anchor,
    replies: entry?.replies ?? [],
  };
}

async function fetchPublication(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const publication = await publications.get(ctx, asString(args.resource_id));
  if (!publication) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  if (args.workspace_id && publication.workspaceId !== args.workspace_id) {
    throw new AppError(
      "PERMISSION_DENIED",
      "workspace_id does not match this publication.",
      403,
    );
  }
  return { publication };
}

export type { McpToolContext };
