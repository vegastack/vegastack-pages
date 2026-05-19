import { AppError } from "@vegastack/pages-core";
import { publications, reviewEvents } from "@vegastack/pages-services";
import { assertPublicationPasswordPolicy } from "../../share-password-policy";
import { absoluteUrl, asString } from "../util";
import {
  assertPublicationPermission,
  getExistingFolder,
  getExistingPage,
} from "../permissions";
import type { McpToolContext } from "../types";

export async function applyPublication(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const resourceType = args.resource_type === "folder" ? "folder" : "page";
  const publicationId = asString(args.publication_id, "");
  const requestedPermission =
    args.permission === "edit" ||
    args.permission === "comment" ||
    args.permission === "view"
      ? args.permission
      : undefined;
  const permission = requestedPermission ?? "view";
  const password =
    args.clear_password === true
      ? null
      : args.password === undefined
        ? undefined
        : args.password
          ? String(args.password)
          : null;
  if (password !== undefined) assertPublicationPasswordPolicy(password);
  if (publicationId) {
    const publication = await assertPublicationPermission(
      context,
      publicationId,
      args.workspace_id,
    );
    // SECURITY: when a caller passes publication_id AND resource_type /
    // resource_id, those must agree with the publication's actual
    // resource. Without this check, an agent that gets the publication
    // id right but the resource_id wrong would silently mutate the
    // wrong publication. (Audit cycle 5 finding.)
    const requestedResourceId = asString(args.resource_id, "");
    if (
      args.resource_type !== undefined &&
      args.resource_type !== publication.resourceType
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "resource_type does not match the publication's resource.",
        400,
        {
          publication_resource_type: publication.resourceType,
          requested: args.resource_type,
        },
      );
    }
    if (requestedResourceId && requestedResourceId !== publication.resourceId) {
      throw new AppError(
        "VALIDATION_ERROR",
        "resource_id does not match the publication's resource.",
        400,
        {
          publication_resource_id: publication.resourceId,
          requested: requestedResourceId,
        },
      );
    }
    const updated = await publications.update(ctx, publication.id, {
      permission: requestedPermission,
      expiresAt:
        args.clear_expires_at === true
          ? null
          : args.expires_at === undefined
            ? undefined
            : args.expires_at
              ? String(args.expires_at)
              : null,
      password,
      indexingEnabled:
        args.indexing_enabled === undefined
          ? undefined
          : Boolean(args.indexing_enabled),
    });
    await reviewEvents.emit(ctx, {
      workspaceId: updated.workspaceId,
      pageId: updated.resourceType === "page" ? updated.resourceId : null,
      type: "publication.updated",
      actorUserId: context.actor.user?.id ?? null,
      payload: { publication_id: updated.id, source: "mcp" },
    });
    return { publication_id: updated.id, publication: updated };
  }
  if (resourceType === "folder") {
    const folder = await getExistingFolder(
      context,
      asString(args.resource_id),
      "admin",
      args.workspace_id,
    );
    const publication = await publications.upsert(ctx, {
      workspaceId: folder.workspaceId,
      resourceType: "folder",
      resourceId: folder.id,
      permission,
      expiresAt:
        args.expires_at === undefined
          ? undefined
          : args.expires_at
            ? String(args.expires_at)
            : null,
      password,
      indexingEnabled:
        args.indexing_enabled === undefined
          ? undefined
          : Boolean(args.indexing_enabled),
    });
    return {
      publication_id: publication.id,
      publication,
      url: absoluteUrl(context, `/f/${folder.slugId}`),
    };
  }
  const page = await getExistingPage(
    context,
    asString(args.resource_id),
    "admin",
    args.workspace_id,
  );
  const publication = await publications.upsert(ctx, {
    workspaceId: page.page.workspaceId,
    resourceType: "page",
    resourceId: page.page.id,
    permission,
    expiresAt:
      args.expires_at === undefined
        ? undefined
        : args.expires_at
          ? String(args.expires_at)
          : null,
    password,
    indexingEnabled:
      args.indexing_enabled === undefined
        ? undefined
        : Boolean(args.indexing_enabled),
  });
  return {
    publication_id: publication.id,
    publication,
    url: absoluteUrl(context, `/p/${page.page.slugId}`),
  };
}

export async function deletePublication(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const publication = await assertPublicationPermission(
    context,
    asString(args.publication_id),
    args.workspace_id,
  );
  const revoked = await publications.revoke(ctx, publication.id);
  await reviewEvents.emit(ctx, {
    workspaceId: revoked.workspaceId,
    pageId: revoked.resourceType === "page" ? revoked.resourceId : null,
    type: "publication.revoked",
    actorUserId: context.actor.user?.id ?? null,
    payload: { publication_id: revoked.id, source: "mcp" },
  });
  return { publication: revoked };
}
