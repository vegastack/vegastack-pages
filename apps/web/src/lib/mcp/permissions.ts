import {
  AppError,
  hasPermission,
  type PermissionLevel,
} from "@vegastack/pages-core";
import {
  comments,
  folders,
  pages,
  permissions as permissionService,
  publications,
  workspaces,
} from "@vegastack/pages-services";
import { assertMcpWorkspaceMatches } from "./util";
import type { McpToolContext } from "./types";

export async function canUseWorkspace(
  context: McpToolContext,
  workspaceId: string,
  required: PermissionLevel,
) {
  const ctx = context.ctx;
  if (context.actor.workspaceId && context.actor.workspaceId !== workspaceId)
    return false;
  const member = context.actor.user
    ? await workspaces.getMember(ctx, {
        workspaceId,
        userId: context.actor.user.id,
      })
    : null;
  const permission = await permissionService.resolve(ctx, {
    workspaceId,
    userId: context.actor.user?.id ?? "",
    scope: "workspace",
    targetId: workspaceId,
    memberRole: member?.role ?? null,
    instanceRole: context.actor.user?.role,
  });
  return hasPermission(permission, required);
}

export async function assertWorkspacePermission(
  context: McpToolContext,
  workspaceId: string,
  required: PermissionLevel,
) {
  if (!(await canUseWorkspace(context, workspaceId, required))) {
    throw new AppError(
      "PERMISSION_DENIED",
      "MCP session does not have permission for this workspace.",
      403,
      {
        workspace_id: workspaceId,
        required,
      },
    );
  }
}

export async function folderAncestorIdsForPath(
  context: McpToolContext,
  workspaceId: string,
  folderPath: string,
): Promise<string[]> {
  if (!folderPath) return [];
  const ctx = context.ctx;
  const all = await folders.listAll(ctx, { workspaceId });
  const folder = all.find((candidate) => candidate.path === folderPath);
  if (!folder) return [];
  return folders.ancestorPath(ctx, folder.id);
}

export async function canUsePage(
  context: McpToolContext,
  page: { id: string; workspaceId: string; folderPath: string },
  required: PermissionLevel,
) {
  const ctx = context.ctx;
  if (
    context.actor.workspaceId &&
    context.actor.workspaceId !== page.workspaceId
  )
    return false;
  const member = context.actor.user
    ? await workspaces.getMember(ctx, {
        workspaceId: page.workspaceId,
        userId: context.actor.user.id,
      })
    : null;
  const ancestorIds = await folderAncestorIdsForPath(
    context,
    page.workspaceId,
    page.folderPath,
  );
  const permission = await permissionService.resolve(ctx, {
    workspaceId: page.workspaceId,
    userId: context.actor.user?.id ?? "",
    scope: "page",
    targetId: page.id,
    memberRole: member?.role ?? null,
    instanceRole: context.actor.user?.role,
    folderPath: ancestorIds,
  });
  return hasPermission(permission, required);
}

export async function canReadPage(
  context: McpToolContext,
  page: { id: string; workspaceId: string; folderPath: string },
) {
  return canUsePage(context, page, "read");
}

export async function assertPagePermission(
  context: McpToolContext,
  page: { id: string; workspaceId: string; folderPath: string },
  required: PermissionLevel,
) {
  if (!(await canUsePage(context, page, required))) {
    throw new AppError(
      "PERMISSION_DENIED",
      "MCP session does not have permission for this page.",
      403,
      {
        page_id: page.id,
        required,
      },
    );
  }
}

export async function canUseFolder(
  context: McpToolContext,
  folder: { id: string; workspaceId: string },
  required: PermissionLevel,
) {
  const ctx = context.ctx;
  if (
    context.actor.workspaceId &&
    context.actor.workspaceId !== folder.workspaceId
  )
    return false;
  const member = context.actor.user
    ? await workspaces.getMember(ctx, {
        workspaceId: folder.workspaceId,
        userId: context.actor.user.id,
      })
    : null;
  const ancestorIds = await folders.ancestorPath(ctx, folder.id);
  const permission = await permissionService.resolve(ctx, {
    workspaceId: folder.workspaceId,
    userId: context.actor.user?.id ?? "",
    scope: "folder",
    targetId: folder.id,
    memberRole: member?.role ?? null,
    instanceRole: context.actor.user?.role,
    folderPath: ancestorIds.filter((id) => id !== folder.id),
  });
  return hasPermission(permission, required);
}

export async function getExistingPage(
  context: McpToolContext,
  pageId: string,
  required: PermissionLevel = "read",
  workspaceValue?: unknown,
) {
  const ctx = context.ctx;
  const page =
    (await pages.get(ctx, pageId)) ?? (await pages.getBySlugId(ctx, pageId));
  if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
  if (workspaceValue !== undefined) {
    assertMcpWorkspaceMatches(workspaceValue, page.page.workspaceId, "page");
  }
  await assertPagePermission(context, page.page, required);
  return page;
}

export async function getExistingFolder(
  context: McpToolContext,
  folderId: string,
  required: PermissionLevel = "read",
  workspaceValue?: unknown,
) {
  const ctx = context.ctx;
  const folder = await folders.get(ctx, folderId);
  if (!folder)
    throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
  if (workspaceValue !== undefined) {
    assertMcpWorkspaceMatches(workspaceValue, folder.workspaceId, "folder");
  }
  if (!(await canUseFolder(context, folder, required))) {
    throw new AppError(
      "PERMISSION_DENIED",
      "MCP session does not have permission for this folder.",
      403,
    );
  }
  return folder;
}

export async function getThreadPage(
  context: McpToolContext,
  threadId: string,
  required: PermissionLevel,
  workspaceValue: unknown,
) {
  const ctx = context.ctx;
  const thread = await comments.getThread(ctx, { threadId });
  if (!thread)
    throw new AppError(
      "THREAD_NOT_FOUND",
      "Comment thread was not found.",
      404,
    );
  const page = await getExistingPage(
    context,
    thread.pageId,
    required,
    workspaceValue,
  );
  return { thread, page };
}

export async function assertPublicationPermission(
  context: McpToolContext,
  publicationId: string,
  workspaceValue: unknown,
) {
  const ctx = context.ctx;
  const publication = await publications.get(ctx, publicationId);
  if (!publication)
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  if (publication.resourceType === "page") {
    await getExistingPage(
      context,
      publication.resourceId,
      "admin",
      workspaceValue,
    );
  } else {
    await getExistingFolder(
      context,
      publication.resourceId,
      "admin",
      workspaceValue,
    );
  }
  return publication;
}
