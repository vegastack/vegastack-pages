// Publication API helpers — admin-only resource publication management.
// Plan 011 §7. Routes for /api/{pages,folders}/[id]/publication go
// through these helpers; the heavy R2 fan-out lives in
// `publications.service.publishFanOut`.

import {
  AppError,
  type FolderRecord,
  type PageRecord,
} from "@vegastack/pages-core";
import type { AstroCookies } from "astro";
import {
  audit,
  folders as foldersService,
  publications as publicationsService,
  reviewEvents,
  type ServiceContext,
} from "@vegastack/pages-services";
import { buildServiceContext } from "./service-context";
import { assertResourceAccessAdmin } from "./access";
import { assertPublicationPasswordPolicy } from "./share-password-policy";
import { invalidatePublicationCache } from "./publication-cache";

type PublicationResource =
  | { type: "page"; page: PageRecord; slugId: string }
  | { type: "folder"; folder: FolderRecord; slugId: string };

function resourceWorkspaceId(resource: PublicationResource) {
  return resource.type === "page"
    ? resource.page.workspaceId
    : resource.folder.workspaceId;
}

function resourceId(resource: PublicationResource) {
  return resource.type === "page" ? resource.page.id : resource.folder.id;
}

function resourceSlugId(resource: PublicationResource) {
  return resource.slugId;
}

export function publicPublicationUrl(resource: PublicationResource) {
  return `/${resource.type === "page" ? "p" : "f"}/${resourceSlugId(resource)}`;
}

export async function serializePublication(
  ctx: ServiceContext,
  resource: PublicationResource,
) {
  const publication = await publicationsService.findForResource(ctx, {
    workspaceId: resourceWorkspaceId(resource),
    resourceType: resource.type,
    resourceId: resourceId(resource),
  });
  return {
    publication: publication
      ? {
          id: publication.id,
          resource_type: publication.resourceType,
          resource_id: publication.resourceId,
          permission: publication.permission,
          expires_at: publication.expiresAt,
          password_enabled: Boolean(publication.passwordHash),
          indexing_enabled: publication.indexingEnabled,
          revoked_at: publication.revokedAt,
          created_at: publication.createdAt,
          updated_at: publication.updatedAt,
          url: publicPublicationUrl(resource),
        }
      : null,
    url: publicPublicationUrl(resource),
  };
}

export async function getPublication(input: {
  cookies: AstroCookies;
  request: Request;
  resource: PublicationResource;
}) {
  await assertResourceAccessAdmin({
    cookies: input.cookies,
    request: input.request,
    resource:
      input.resource.type === "page"
        ? { scope: "page", page: input.resource.page }
        : { scope: "folder", folder: input.resource.folder },
  });
  const { ctx } = await buildServiceContext({
    cookies: input.cookies,
    request: input.request,
    workspaceId: resourceWorkspaceId(input.resource),
  });
  return serializePublication(ctx, input.resource);
}

export async function upsertPublication(input: {
  cookies: AstroCookies;
  request: Request;
  resource: PublicationResource;
  body: unknown;
}) {
  const access = await assertResourceAccessAdmin({
    cookies: input.cookies,
    request: input.request,
    resource:
      input.resource.type === "page"
        ? { scope: "page", page: input.resource.page }
        : { scope: "folder", folder: input.resource.folder },
  });
  const body = input.body as Record<string, unknown>;
  const permission =
    body.permission === "edit" || body.permission === "comment"
      ? body.permission
      : "view";
  const password =
    body.password === undefined
      ? undefined
      : body.password
        ? String(body.password)
        : null;
  if (password !== undefined) assertPublicationPasswordPolicy(password);
  const { ctx } = await buildServiceContext({
    cookies: input.cookies,
    request: input.request,
    workspaceId: resourceWorkspaceId(input.resource),
  });
  const publication = await publicationsService.upsert(ctx, {
    workspaceId: resourceWorkspaceId(input.resource),
    resourceType: input.resource.type,
    resourceId: resourceId(input.resource),
    permission,
    expiresAt:
      body.expires_at === undefined
        ? undefined
        : body.expires_at
          ? String(body.expires_at)
          : null,
    password,
    indexingEnabled:
      body.indexing_enabled === undefined
        ? undefined
        : Boolean(body.indexing_enabled),
  });
  await audit.record(ctx, {
    workspaceId: publication.workspaceId,
    actorUserId: access.actor.user?.id ?? null,
    action: "publication.upserted",
    targetType: publication.resourceType,
    targetId: publication.resourceId,
    metadata: { permission: publication.permission },
  });
  await reviewEvents.emit(ctx, {
    workspaceId: publication.workspaceId,
    pageId: input.resource.type === "page" ? input.resource.page.id : null,
    type: "publication.updated",
    actorUserId: access.actor.user?.id ?? null,
    payload: {
      publication_id: publication.id,
      resource_type: publication.resourceType,
      resource_id: publication.resourceId,
    },
  });
  // Toggling password or indexing settings changes the publication's
  // cacheability and ETag. Drop the edge cache entry so anonymous viewers
  // re-fetch with the new policy on the next hit.
  const origin = new URL(input.request.url).origin;
  ctx.waitUntil(
    invalidatePublicationCache({
      publication,
      slug: resourceSlugId(input.resource),
      publicOrigin: origin,
    }),
  );
  return serializePublication(ctx, input.resource);
}

export async function deletePublication(input: {
  cookies: AstroCookies;
  request: Request;
  resource: PublicationResource;
}) {
  const access = await assertResourceAccessAdmin({
    cookies: input.cookies,
    request: input.request,
    resource:
      input.resource.type === "page"
        ? { scope: "page", page: input.resource.page }
        : { scope: "folder", folder: input.resource.folder },
  });
  const { ctx } = await buildServiceContext({
    cookies: input.cookies,
    request: input.request,
    workspaceId: resourceWorkspaceId(input.resource),
  });
  const publication = await publicationsService.findForResource(ctx, {
    workspaceId: resourceWorkspaceId(input.resource),
    resourceType: input.resource.type,
    resourceId: resourceId(input.resource),
  });
  if (!publication) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  const revoked = await publicationsService.revoke(ctx, publication.id);
  await audit.record(ctx, {
    workspaceId: revoked.workspaceId,
    actorUserId: access.actor.user?.id ?? null,
    action: "publication.revoked",
    targetType: revoked.resourceType,
    targetId: revoked.resourceId,
    metadata: { publication_id: revoked.id },
  });
  // Revoke must immediately stop serving the public artifact. Drop the
  // edge cache so subsequent anonymous reads fall through to SSR and
  // return 404 on the revoked publication.
  const origin = new URL(input.request.url).origin;
  ctx.waitUntil(
    invalidatePublicationCache({
      publication: revoked,
      slug: resourceSlugId(input.resource),
      publicOrigin: origin,
    }),
  );
  return serializePublication(ctx, input.resource);
}

// folderSubtreePageIds builds a predicate that returns true for pages
// inside a folder's subtree. Async because it queries D1 for the
// workspace's folder set.
export async function folderSubtreePageIds(
  ctx: ServiceContext,
  folder: FolderRecord,
) {
  const prefix = `${folder.path}/`;
  const allFolders = await foldersService.listAll(ctx, {
    workspaceId: folder.workspaceId,
  });
  const folderIds = new Set(
    allFolders
      .filter(
        (candidate) =>
          candidate.id === folder.id || candidate.path.startsWith(prefix),
      )
      .map((candidate) => candidate.id),
  );
  const folderByPath = new Map(allFolders.map((f) => [f.path, f]));
  return (page: PageRecord) => {
    if (page.workspaceId !== folder.workspaceId) return false;
    if (!page.folderPath) return false;
    const pageFolder = folderByPath.get(page.folderPath);
    return Boolean(pageFolder && folderIds.has(pageFolder.id));
  };
}
