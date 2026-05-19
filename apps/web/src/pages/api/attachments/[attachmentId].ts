import type { APIRoute } from "astro";
import {
  attachments as attachmentsService,
  pages as pagesService,
} from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../lib/access";
import { buildServiceContext } from "../../../lib/service-context";

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
    const { ctx } = await buildServiceContext({ cookies, request });
    const attachment = params.attachmentId
      ? await attachmentsService.get(ctx, params.attachmentId)
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
    const page = await pagesService.get(ctx, attachment.pageId);
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
    const stored = await ctx.objectStore?.get(attachment.objectKey);
    if (!stored) {
      return Response.json(
        {
          error: {
            code: "PAGE_NOT_FOUND",
            message: "Attachment body was not found.",
          },
        },
        { status: 404 },
      );
    }
    const bytes = decodeBase64(stored.body);
    const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Response(copy.buffer, {
      headers: {
        "Content-Type": attachment.contentType,
        "Content-Disposition": contentDisposition({
          contentType: attachment.contentType,
          filename: attachment.filename,
        }),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    return jsonAppError(error, "Attachment fetch failed.");
  }
};
