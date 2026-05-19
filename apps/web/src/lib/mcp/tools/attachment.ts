import { attachments, reviewEvents } from "@vegastack/pages-services";
import { absoluteUrl, asString } from "../util";
import { getExistingPage } from "../permissions";
import type { McpToolContext } from "../types";

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
  const body = asString(args.base64_body);
  const attachment = await attachments.upload(ctx, {
    workspaceId: page.page.workspaceId,
    pageId: page.page.id,
    filename: asString(args.filename),
    contentType: asString(args.content_type),
    body,
    byteSize: body.length,
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
