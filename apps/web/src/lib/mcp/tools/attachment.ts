import { AppError } from "@vegastack/pages-core";
import { attachments, reviewEvents } from "@vegastack/pages-services";
import { absoluteUrl, asString } from "../util";
import { getExistingPage } from "../permissions";
import type { McpToolContext } from "../types";

function decodeBase64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "base64_body must be valid base64-encoded bytes.",
      400,
    );
  }
}

export async function uploadAttachment(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  const page = await getExistingPage(
    context,
    asString(args.page_id),
    "write",
    args.workspace_id,
  );
  const base64 = asString(args.base64_body);
  if (!base64) {
    throw new AppError("VALIDATION_ERROR", "base64_body is required.", 400);
  }
  // Decode the base64 string into raw bytes before storing. Passing the
  // base64 string directly stored the text-encoded payload instead of
  // the original binary, breaking every non-text attachment downloaded
  // afterwards.
  const bytes = decodeBase64ToBytes(base64);
  const attachment = await attachments.upload(ctx, {
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    filename: asString(args.filename),
    contentType: asString(args.content_type),
    body: bytes,
    byteSize: bytes.byteLength,
  });
  await reviewEvents.emit(ctx, {
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    type: "attachment.uploaded",
    actorUserId: null,
    payload: {
      attachment_id: attachment.id,
      filename: attachment.filename,
      source: "mcp",
    },
  });
  return {
    attachment,
    url: absoluteUrl(
      context,
      `/api/attachments/${attachment.id}?workspace_id=${encodeURIComponent(page.page.workspaceId)}`,
    ),
  };
}
