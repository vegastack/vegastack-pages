// AttachmentsService — file uploads attached to pages.

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type {
  AttachmentRecord,
  AttachmentUploadInput,
} from "./repo/attachment.repo.ts";
import { buildEnvelope } from "./envelope.ts";

export type AttachmentMutation<Data> = {
  data: Data;
  envelope: MutationEnvelope;
};

export async function upload(
  ctx: ServiceContext,
  input: AttachmentUploadInput,
): Promise<AttachmentMutation<AttachmentRecord>> {
  const attachment = await ctx.repo.attachments.upload(input);
  const treeVersion = await ctx.computeTreeVersion(attachment.workspaceId);
  return {
    data: attachment,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `attachment:${attachment.id}`,
        `attachments:${input.page.id}`,
      ],
    }),
  };
}

export async function listForPage(
  ctx: ServiceContext,
  input: { pageId: string },
): Promise<AttachmentRecord[]> {
  return ctx.repo.attachments.listForPage(input.pageId);
}

export async function get(
  ctx: ServiceContext,
  input: { attachmentId: string },
): Promise<{ attachment: AttachmentRecord; base64Body: string } | null> {
  return ctx.repo.attachments.get(input);
}
