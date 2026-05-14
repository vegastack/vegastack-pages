import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../lib/access";
import {
  attachmentService,
  ensureSeedData,
  pageService,
} from "../../../lib/runtime";

export const prerender = false;

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

const inlineAttachmentTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function contentDisposition(input: { contentType: string; filename: string }) {
  const disposition = inlineAttachmentTypes.has(input.contentType)
    ? "inline"
    : "attachment";
  const filename = input.filename.replace(/["\r\n]/g, "");
  return `${disposition}; filename="${filename}"`;
}

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const attachment = params.attachmentId
      ? await attachmentService.get(params.attachmentId)
      : null;
    if (!attachment) {
      return Response.json(
        {
          error: {
            code: "PAGE_NOT_FOUND",
            message: "Attachment was not found.",
          },
        },
        { status: 404 },
      );
    }
    const page = await pageService.getPage(attachment.attachment.pageId);
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
    const bytes = decodeBase64(attachment.base64Body);
    const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Response(copy.buffer, {
      headers: {
        "Content-Type": attachment.attachment.contentType,
        "Content-Disposition": contentDisposition({
          contentType: attachment.attachment.contentType,
          filename: attachment.attachment.filename,
        }),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    return jsonAppError(error, "Attachment fetch failed.");
  }
};
