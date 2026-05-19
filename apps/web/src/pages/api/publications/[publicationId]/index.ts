import { AppError, hasPermission } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  buildEnvelope,
  folders,
  isServiceError,
  jsonWithEnvelope,
  pages as pagesService,
  publications,
} from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  jsonAppError,
  resolveActorPermission,
  resolveFolderActorPermission,
} from "../../../../lib/access";
import { assertPublicationPasswordPolicy } from "../../../../lib/share-password-policy";
import { buildServiceContext } from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;

async function assertPublicationAdmin(input: {
  cookies: Parameters<typeof getApiRequestActor>[0];
  request: Request;
  url: URL;
  publicationId: string;
}) {
  // Look up the publication first to learn its workspace, then build
  // the per-workspace ctx for the actual mutation below.
  const bootstrap = await buildServiceContext({
    cookies: input.cookies,
    request: input.request,
  });
  const publication = await publications.get(
    bootstrap.ctx,
    input.publicationId,
  );
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
  let actual: Awaited<ReturnType<typeof resolveActorPermission>>;
  if (publication.resourceType === "page") {
    // pages.list returns the full workspace listing; find the target
    // page so the legacy resolveActorPermission helper can compute the
    // effective level (membership + grants).
    const pageList = await pagesService.list(
      bootstrap.ctx,
      publication.workspaceId,
    );
    const page = pageList.find(
      (candidate) => candidate.id === publication.resourceId,
    );
    if (!page) {
      throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    }
    actual = await resolveActorPermission({ actor, page });
  } else {
    const folder = await folders.get(bootstrap.ctx, publication.resourceId);
    if (!folder) {
      throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
    }
    actual = await resolveFolderActorPermission({ actor, folder });
  }
  if (!hasPermission(actual, "admin")) {
    throw new AppError("PERMISSION_DENIED", "Insufficient permission.", 403, {
      required: "admin",
      actual,
    });
  }
  return { actor, publication, ctx: bootstrap.ctx };
}

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { actor, publication, ctx } = await assertPublicationAdmin({
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
    const updated = await publications.update(ctx, publication.id, {
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
    const treeVersion = (
      await buildWorkspaceNavigation(actor, publication.workspaceId)
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
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Publication update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { actor, publication, ctx } = await assertPublicationAdmin({
      cookies,
      request,
      url,
      publicationId: params.publicationId ?? "",
    });
    const revoked = await publications.revoke(ctx, publication.id);
    const treeVersion = (
      await buildWorkspaceNavigation(actor, publication.workspaceId)
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
    if (isServiceError(error)) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return jsonAppError(error, "Publication removal failed.");
  }
};
