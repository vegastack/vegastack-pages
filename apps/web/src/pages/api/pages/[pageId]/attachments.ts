import type { APIRoute } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { numericEnv, readJsonBody } from "../../../../lib/request-body";
import {
  attachmentService,
  auditService,
  checkRateLimit,
  ensureSeedData,
  pageService,
  reviewEventService,
} from "../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;
const defaultMaxAttachmentBytes = 10_485_760;
const jsonOverheadBytes = 64 * 1024;

function maxAttachmentBytes() {
  return numericEnv("VPG_MAX_ATTACHMENT_BYTES", defaultMaxAttachmentBytes);
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
      required: "read",
    });
    return Response.json({
      attachments: attachmentService.listForPage(page.page.id),
    });
  } catch (error) {
    return jsonAppError(error, "Attachment listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
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
    const maxJsonBytes =
      Math.ceil((maxAttachmentBytes() * 4) / 3) + jsonOverheadBytes;
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxJsonBytes,
      label: "Attachment upload",
    });
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
      guestName: body.guest_name ? String(body.guest_name) : null,
    });
    await checkRateLimit({
      key: `attachment:${access.actor.user?.id ?? access.publicationId ?? page.page.id}`,
      limit: 30,
      windowMs: 60 * 60_000,
    });
    const attachment = await attachmentService.upload({
      page: page.page,
      filename: String(body.filename ?? ""),
      contentType: String(body.content_type ?? ""),
      base64Body: String(body.base64_body ?? ""),
    });
    auditService.record({
      workspaceId: page.page.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "attachment.uploaded",
      targetType: "attachment",
      targetId: attachment.id,
      metadata: { page_id: page.page.id, filename: attachment.filename },
    });
    reviewEventService.emit({
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "attachment.uploaded",
      actorUserId: access.actor.user?.id ?? null,
      payload: { attachment_id: attachment.id, filename: attachment.filename },
    });
    const treeVersion = buildWorkspaceNavigation(
      access.actor,
      page.page.workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      {
        attachment,
        url: `/api/attachments/${attachment.id}?workspace_id=${encodeURIComponent(page.page.workspaceId)}`,
      },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [
          `attachment:${attachment.id}`,
          `attachments:${page.page.id}`,
        ],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "Attachment upload failed.");
  }
};
