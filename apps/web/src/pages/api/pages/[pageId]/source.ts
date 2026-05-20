import type { APIRoute } from "astro";
import { stripLeadingTitleFromSource } from "@vegastack/pages-core";
import { pages as pagesService, reviewEvents } from "@vegastack/pages-services";
import { resolvePageAccess } from "../../../../lib/access";
import {
  assertUtf8ByteLimit,
  numericEnv,
  readJsonBody,
} from "../../../../lib/request-body";
import { scheduleIndexPage } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;
const defaultMaxPageSourceBytes = 1_048_576;
const jsonOverheadBytes = 64 * 1024;

function maxPageSourceBytes() {
  return numericEnv("VPG_MAX_PAGE_SOURCE_BYTES", defaultMaxPageSourceBytes);
}

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.pageId
      ? await pagesService.get(ctx, params.pageId)
      : null;
    if (!page) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: url.searchParams.get("intent") === "edit" ? "write" : "read",
    });
    return Response.json({
      page_id: page.page.id,
      source_type: page.page.sourceType,
      source: page.source,
      version_id: page.page.versionId,
      etag: page.page.contentHash,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Source fetch failed.");
  }
};

export const PUT: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const maxSourceBytes = maxPageSourceBytes();
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxSourceBytes + jsonOverheadBytes,
      label: "Page source update",
    });
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.pageId
      ? await pagesService.get(ctx, params.pageId)
      : null;
    if (!page) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
      guestName: body.guest_name ? String(body.guest_name) : null,
    });
    // Strip a leading `# {title}` (markdown/mdx) or `<h1>{title}</h1>`
    // (html) BEFORE the unchanged-check so callers re-sending the
    // editor's rendered source (which never includes the title H1)
    // still trip the no-op guard. The service layer also strips on
    // persist; matching here keeps the comparison consistent.
    const source = stripLeadingTitleFromSource(
      String(body.source ?? ""),
      page.page.title,
      page.page.sourceType,
    );
    if (
      body.base_content_hash &&
      page.page.contentHash !== String(body.base_content_hash)
    ) {
      return Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "Page content hash has changed since it was loaded.",
            details: {
              current_version_id: page.page.versionId,
              current_content_hash: page.page.contentHash,
              updated_at: page.page.updatedAt,
            },
          },
        },
        { status: 409 },
      );
    }
    if (!body.allow_noop && source === page.source) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Page source is unchanged. Pass allow_noop=true to save anyway.",
            details: {
              current_version_id: page.page.versionId,
              current_content_hash: page.page.contentHash,
            },
          },
        },
        { status: 400 },
      );
    }
    assertUtf8ByteLimit({
      value: source,
      maxBytes: maxSourceBytes,
      label: "Page source",
      detailKey: "max_page_source_bytes",
    });

    // Hand off to the service layer. The route keeps HTTP-shaped
    // validation (conflict check, noop check, byte limit) above; the
    // service layer owns the actual mutation + envelope construction.
    const result = await pagesService.updateSource(ctx, {
      pageId: params.pageId ?? "",
      source,
      baseVersionId: String(body.base_version_id ?? ""),
      checkpoint: Boolean(body.checkpoint),
      checkpointLabel: body.checkpoint_label
        ? String(body.checkpoint_label)
        : null,
    });
    const updated = result.data;

    // Side effects that remain outside the service: review event emission
    // and search re-indexing. These should move to ctx.waitUntil once the
    // Cloudflare runtime adapter is wired (plan §A.4).
    scheduleIndexPage(updated.page.id);
    await reviewEvents.emit(ctx, {
      workspaceId: updated.page.workspaceId,
      pageId: updated.page.id,
      type: updated.checkpointCreated ? "page.version_created" : "page.updated",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        version_id: updated.page.versionId,
        checkpoint_created: updated.checkpointCreated,
      },
    });

    return Response.json({
      page_id: updated.page.id,
      slug_id: updated.page.slugId,
      url: `/p/${updated.page.slugId}`,
      version_id: updated.page.versionId,
      content_hash: updated.page.contentHash,
      updated_at: updated.page.updatedAt,
      checkpoint_created: updated.checkpointCreated,
      changed: updated.changed,
      render_status: "queued",
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Source update failed.");
  }
};
