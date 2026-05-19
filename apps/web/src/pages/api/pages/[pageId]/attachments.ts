import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  attachments as attachmentsService,
  audit,
  buildEnvelope,
  jsonWithEnvelope,
  pages as pagesService,
  rateLimit,
  reviewEvents,
} from "@vegastack/pages-services";
import { resolvePageAccess } from "../../../../lib/access";
import { numericEnv, readJsonBody } from "../../../../lib/request-body";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

export const prerender = false;
const defaultMaxAttachmentBytes = 10_485_760;
const jsonOverheadBytes = 64 * 1024;

// Content-type allowlist for the image-proxy-served `/img/attachments/`
// path. Anything outside this list is uploaded but served from a
// gated route (not `/img/...`). Limits XSS / drive-by surface from
// public-by-key attachment URLs. SVG and HTML are intentionally
// excluded — they execute script.
const IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/avif",
  "image/gif",
]);

function maxAttachmentBytes() {
  return numericEnv("VPG_MAX_ATTACHMENT_BYTES", defaultMaxAttachmentBytes);
}

function parseDimension(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) return null;
  return Math.floor(parsed);
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
      required: "read",
    });
    return Response.json({
      attachments: await attachmentsService.listForPage(ctx, {
        pageId: page.page.id,
      }),
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Attachment listing failed.");
  }
};

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
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

    const maxBytes = maxAttachmentBytes();
    const contentType = (request.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();

    // Two upload shapes:
    //   1. Binary direct upload (preferred): the client compresses the
    //      image client-side (apps/web/src/scripts/upload-image.ts),
    //      then POSTs the raw bytes with image/* content-type plus
    //      x-filename / x-image-width / x-image-height headers.
    //   2. JSON base64 upload (legacy MCP path): callers that can't
    //      stream binary send `{filename, content_type, base64_body}`.
    // Both paths funnel into attachments.upload, which now accepts
    // either an ArrayBuffer or a string body.
    let uploadInput: {
      filename: string;
      contentType: string;
      body: string | ArrayBuffer;
      byteSize: number;
      imageWidth: number | null;
      imageHeight: number | null;
      guestName: string | null;
    };

    if (contentType === "application/json") {
      const maxJsonBytes = Math.ceil((maxBytes * 4) / 3) + jsonOverheadBytes;
      const body = await readJsonBody<Record<string, unknown>>(request, {
        maxBytes: maxJsonBytes,
        label: "Attachment upload",
      });
      const base64Body = String(body.base64_body ?? "");
      // base64 expands by 4/3; the underlying byte size is the source
      // length less padding. This is what users see for storage quota.
      const decodedBytes = Math.floor(
        (base64Body.replace(/=+$/, "").length * 3) / 4,
      );
      if (decodedBytes > maxBytes) {
        throw new AppError(
          "PAYLOAD_TOO_LARGE",
          `Attachment exceeds maximum size of ${maxBytes} bytes.`,
          413,
        );
      }
      uploadInput = {
        filename: String(body.filename ?? ""),
        contentType: String(body.content_type ?? ""),
        body: base64Body,
        byteSize: decodedBytes,
        imageWidth:
          typeof body.image_width === "number" ? body.image_width : null,
        imageHeight:
          typeof body.image_height === "number" ? body.image_height : null,
        guestName: body.guest_name ? String(body.guest_name) : null,
      };
    } else {
      if (!IMAGE_CONTENT_TYPES.has(contentType)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Unsupported image content-type: ${contentType || "(missing)"}.`,
          400,
          { allowed: [...IMAGE_CONTENT_TYPES] },
        );
      }
      // Pre-check via Content-Length so a hostile client can't tie up
      // the Worker streaming gigabytes before we reject.
      const declared = Number(request.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new AppError(
          "PAYLOAD_TOO_LARGE",
          `Attachment exceeds maximum size of ${maxBytes} bytes.`,
          413,
        );
      }
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new AppError(
          "PAYLOAD_TOO_LARGE",
          `Attachment exceeds maximum size of ${maxBytes} bytes.`,
          413,
        );
      }
      const filename =
        request.headers.get("x-filename")?.trim() || "attachment.webp";
      uploadInput = {
        filename,
        contentType,
        body: buffer,
        byteSize: buffer.byteLength,
        imageWidth: parseDimension(request.headers.get("x-image-width")),
        imageHeight: parseDimension(request.headers.get("x-image-height")),
        guestName: null,
      };
    }

    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
      guestName: uploadInput.guestName,
    });
    const rl = await rateLimit.check(ctx, {
      key: `attachment:${access.actor.user?.id ?? access.publicationId ?? page.page.id}`,
      limit: 30,
      windowMs: 60 * 60_000,
    });
    if (!rl.ok) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        { reset_at: rl.resetAt },
      );
    }
    const attachment = await attachmentsService.upload(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      filename: uploadInput.filename,
      contentType: uploadInput.contentType,
      body: uploadInput.body,
      byteSize: uploadInput.byteSize,
      imageWidth: uploadInput.imageWidth,
      imageHeight: uploadInput.imageHeight,
    });
    await audit.record(ctx, {
      workspaceId: page.page.workspaceId,
      actorUserId: access.actor.user?.id ?? null,
      action: "attachment.uploaded",
      targetType: "attachment",
      targetId: attachment.id,
      metadata: { page_id: page.page.id, filename: attachment.filename },
    });
    await reviewEvents.emit(ctx, {
      workspaceId: page.page.workspaceId,
      pageId: page.page.id,
      type: "attachment.uploaded",
      actorUserId: access.actor.user?.id ?? null,
      payload: { attachment_id: attachment.id, filename: attachment.filename },
    });
    const treeVersion = (
      await buildWorkspaceNavigation(access.actor, page.page.workspaceId)
    ).treeVersion;
    return jsonWithEnvelope(
      {
        attachment,
        // Use the public R2-proxied path for images so the client gets a
        // browser-cacheable URL with image/* content-type. The legacy
        // /api/attachments/:id endpoint stays for non-image downloads.
        url: IMAGE_CONTENT_TYPES.has(attachment.contentType.toLowerCase())
          ? `/img/${attachment.objectKey}`
          : `/api/attachments/${attachment.id}?workspace_id=${encodeURIComponent(page.page.workspaceId)}`,
        object_key: attachment.objectKey,
        image_width: attachment.imageWidth,
        image_height: attachment.imageHeight,
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
    return serviceErrorToResponse(error, "Attachment upload failed.");
  }
};
