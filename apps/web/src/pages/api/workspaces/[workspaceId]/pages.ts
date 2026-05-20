import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  folders as foldersService,
  pages as pagesService,
  permissions as permissionsService,
  rateLimit,
  reviewEvents,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import { getApiRequestActor } from "../../../../lib/access";
import { clientRateLimitKey } from "../../../../lib/client-address";
import { scheduleIndexPage } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const body = await request.json();
    const workspaceId = params.workspaceId?.trim();
    if (!workspaceId) {
      throw new AppError("VALIDATION_ERROR", "workspace id is required.", 400);
    }
    const actor = await getApiRequestActor(cookies, request);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId,
    });
    const member = actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId,
          userId: actor.user.id,
        })
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : await permissionsService.resolve(ctx, {
            workspaceId,
            userId: actor.user?.id ?? "",
            scope: "workspace",
            targetId: workspaceId,
            memberRole: member?.role ?? null,
            instanceRole: actor.user?.role,
          });
    permissionsService.assertLevel({ actual: permission, required: "write" });
    // Anti-abuse: 60 page creations per user per minute. Generous for
    // template-driven bulk creates, tight enough to slow runaway scripts
    // and the public-signup-on case where any signed-in user can create.
    const rl = await rateLimit.check(ctx, {
      key: `pages-create:${actor.user?.id ?? clientRateLimitKey(request, "anon")}`,
      limit: 60,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        { reset_at: rl.resetAt },
      );
    }
    const folder = body.folder_id
      ? await foldersService.get(ctx, String(body.folder_id))
      : null;
    if (body.folder_id && (!folder || folder.workspaceId !== workspaceId)) {
      throw new AppError(
        "FOLDER_NOT_FOUND",
        "Folder was not found in this workspace.",
        404,
      );
    }
    const titleInput = String(body.title ?? "").trim();
    if (!titleInput) {
      throw new AppError(
        "VALIDATION_ERROR",
        "title is required and must be a non-empty string.",
        400,
      );
    }
    const result = await pagesService.create(ctx, {
      workspaceId,
      folderPath:
        folder?.path ??
        (typeof body.folder_path === "string" ? body.folder_path : ""),
      title: titleInput,
      sourceType:
        body.source_type === "mdx" || body.source_type === "html"
          ? body.source_type
          : "markdown",
      source: String(body.source ?? ""),
    });
    const created = result.data;
    scheduleIndexPage(created.page.id);
    await audit.record(ctx, {
      workspaceId: created.page.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "page.created",
      targetType: "page",
      targetId: created.page.id,
      metadata: {
        title: created.page.title,
        folder_path: created.page.folderPath,
      },
    });
    await reviewEvents.emit(ctx, {
      workspaceId: created.page.workspaceId,
      pageId: created.page.id,
      type: "page.created",
      actorUserId: actor.user?.id ?? null,
      payload: { title: created.page.title, slug_id: created.page.slugId },
    });

    return Response.json({
      page_id: created.page.id,
      slug_id: created.page.slugId,
      url: `/p/${created.page.slugId}`,
      version_id: created.page.versionId,
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Page creation failed.");
  }
};
