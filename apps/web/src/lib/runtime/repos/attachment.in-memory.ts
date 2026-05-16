// In-memory AttachmentRepo adapter wrapping attachmentService.

import type {
  AttachmentRepo,
  AttachmentRecord,
  AttachmentUploadInput,
} from "@vegastack/pages-services";
import { attachmentService } from "../../runtime";

export function createInMemoryAttachmentRepo(): AttachmentRepo {
  return {
    async upload(input: AttachmentUploadInput): Promise<AttachmentRecord> {
      return attachmentService.upload({
        page: input.page,
        filename: input.filename,
        contentType: input.contentType,
        base64Body: input.base64Body,
      });
    },
    async get(input: {
      attachmentId: string;
    }): Promise<{ attachment: AttachmentRecord; base64Body: string } | null> {
      return attachmentService.get(input.attachmentId);
    },
    async listForPage(pageId: string): Promise<AttachmentRecord[]> {
      return attachmentService.listForPage(pageId);
    },
  };
}
