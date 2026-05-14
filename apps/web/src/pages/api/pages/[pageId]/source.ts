import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import {
  assertUtf8ByteLimit,
  numericEnv,
  readJsonBody,
} from "../../../../lib/request-body";
import {
  ensureSeedData,
  indexPage,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";

export const prerender = false;
const defaultMaxPageSourceBytes = 1_048_576;
const jsonOverheadBytes = 64 * 1024;

function maxPageSourceBytes() {
  return numericEnv("VPG_MAX_PAGE_SOURCE_BYTES", defaultMaxPageSourceBytes);
}

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
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
    return jsonAppError(error, "Source fetch failed.");
  }
};

export const PUT: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const maxSourceBytes = maxPageSourceBytes();
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxSourceBytes + jsonOverheadBytes,
      label: "Page source update",
    });
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
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
    const source = String(body.source ?? "");
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
    const updated = await pageService.updateSource({
      pageId: params.pageId ?? "",
      source,
      baseVersionId: String(body.base_version_id ?? ""),
      checkpoint: Boolean(body.checkpoint),
      checkpointLabel: body.checkpoint_label
        ? String(body.checkpoint_label)
        : null,
    });
    await indexPage(updated.page.id);
    reviewEventService.emit({
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
    });
  } catch (error) {
    return jsonAppError(error, "Source update failed.");
  }
};
