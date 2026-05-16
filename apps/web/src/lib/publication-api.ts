import {
  AppError,
  type FolderRecord,
  type PageRecord,
} from "@vegastack/pages-core";
import type { AstroCookies } from "astro";
import { assertResourceAccessAdmin } from "./access";
import { assertPublicationPasswordPolicy } from "./share-password-policy";
import {
  auditService,
  publicationService,
  reviewEventService,
  workspaceService,
} from "./runtime";

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

export function serializePublication(resource: PublicationResource) {
  const publication = publicationService.findForResource(
    resource.type,
    resourceId(resource),
  );
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
  return serializePublication(input.resource);
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
  const publication = await publicationService.upsert({
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
  auditService.record({
    workspaceId: publication.workspaceId,
    actorUserId: access.actor.user?.id ?? null,
    action: "publication.upserted",
    targetType: publication.resourceType,
    targetId: publication.resourceId,
    metadata: { permission: publication.permission },
  });
  reviewEventService.emit({
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
  return serializePublication(input.resource);
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
  const publication = publicationService.findForResource(
    input.resource.type,
    resourceId(input.resource),
  );
  if (!publication) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  const revoked = publicationService.revoke(publication.id);
  auditService.record({
    workspaceId: revoked.workspaceId,
    actorUserId: access.actor.user?.id ?? null,
    action: "publication.revoked",
    targetType: revoked.resourceType,
    targetId: revoked.resourceId,
    metadata: { publication_id: revoked.id },
  });
  return serializePublication(input.resource);
}

export function folderSubtreePageIds(folder: FolderRecord) {
  const prefix = `${folder.path}/`;
  const folderIds = new Set(
    workspaceService
      .listFolders(folder.workspaceId)
      .filter(
        (candidate) =>
          candidate.id === folder.id || candidate.path.startsWith(prefix),
      )
      .map((candidate) => candidate.id),
  );
  return (page: PageRecord) => {
    if (page.workspaceId !== folder.workspaceId) return false;
    if (!page.folderPath) return false;
    const pageFolder = workspaceService
      .listFolders(folder.workspaceId)
      .find((candidate) => candidate.path === page.folderPath);
    return Boolean(pageFolder && folderIds.has(pageFolder.id));
  };
}
