// AttachmentRepo — uploaded files attached to pages.
//
// Attachments are addressed by `(workspace_id, page_id, attachment_id)`
// and stored in R2 (Cloudflare) or filesystem (Node self-host). The
// repo is intentionally narrow: just upload, list, get. Deleting an
// attachment is currently a soft no-op (callers should remove references
// from the page source). The full lifecycle (signed URLs, garbage
// collection) is owned by `attachmentService` on apps/web.

import type { AttachmentRecord, PageRecord } from "@vegastack/pages-core";

export type { AttachmentRecord };

export type AttachmentUploadInput = {
  page: PageRecord;
  filename: string;
  contentType: string;
  base64Body: string;
};

export type AttachmentRepo = {
  upload(input: AttachmentUploadInput): Promise<AttachmentRecord>;
  // Returns the attachment record + body as base64. The encoding choice
  // matches the existing AttachmentService surface so the in-memory and
  // R2 implementations share one shape. Callers needing raw bytes
  // `atob()` once.
  get(input: { attachmentId: string }): Promise<{
    attachment: AttachmentRecord;
    base64Body: string;
  } | null>;
  listForPage(pageId: string): Promise<AttachmentRecord[]>;
};
