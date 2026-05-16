import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import { assertApiWorkspaceId, jsonAppError } from "../../../../lib/access";
import { assertPublicationPasswordPolicy } from "../../../../lib/share-password-policy";
import {
  ensureSeedData,
  pageService,
  permissionService,
  publicationService,
  workspaceService,
} from "../../../../lib/runtime";
import {
  resolveActorPermission,
  resolveFolderActorPermission,
  getApiRequestActor,
} from "../../../../lib/access";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function assertPublicationAdmin(input: {
  cookies: Parameters<typeof getApiRequestActor>[0];
  request: Request;
  url: URL;
  publicationId: string;
}) {
  await ensureSeedData();
  const publication = publicationService.get(input.publicationId);
  if (!publication) {
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  }
  assertApiWorkspaceId({
    url: input.url,
    workspaceId: publication.workspaceId,
  });
  const actor = await getApiRequestActor(input.cookies, input.request);
  const actual =
    publication.resourceType === "page"
      ? (() => {
          const page = pageService
            .listPages(publication.workspaceId)
            .find((candidate) => candidate.id === publication.resourceId);
          if (!page)
            throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
          return resolveActorPermission({ actor, page });
        })()
      : (() => {
          const folder = workspaceService.getFolder(publication.resourceId);
          if (!folder)
            throw new AppError(
              "FOLDER_NOT_FOUND",
              "Folder was not found.",
              404,
            );
          return resolveFolderActorPermission({ actor, folder });
        })();
  permissionService.assert({ actual, required: "admin" });
  return publication;
}

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const publication = await assertPublicationAdmin({
      cookies,
      request,
      url,
      publicationId: params.publicationId ?? "",
    });
    const body = await request.json();
    const password =
      body.password === undefined
        ? undefined
        : body.password
          ? String(body.password)
          : null;
    if (password !== undefined) assertPublicationPasswordPolicy(password);
    const updated = await publicationService.update(publication.id, {
      permission:
        body.permission === "view" ||
        body.permission === "comment" ||
        body.permission === "edit"
          ? body.permission
          : undefined,
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
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = buildWorkspaceNavigation(
      actor,
      publication.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { publication: updated },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `publication:${publication.id}`,
          `publication:${publication.resourceType}:${publication.resourceId}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Publication update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const publication = await assertPublicationAdmin({
      cookies,
      request,
      url,
      publicationId: params.publicationId ?? "",
    });
    const revoked = publicationService.revoke(publication.id);
    const actor = await getApiRequestActor(cookies, request);
    const treeVersion = buildWorkspaceNavigation(
      actor,
      publication.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { publication: revoked },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `publication:${publication.id}`,
          `publication:${publication.resourceType}:${publication.resourceId}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Publication removal failed.");
  }
};
