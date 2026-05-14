import { AppError } from "./errors";
import { createId, idPrefixes, slugifyTitle } from "./ids";
import type { ObjectStore } from "./object-store";
import type { PageRecord } from "./page-service";

export type AttachmentRecord = {
  id: string;
  workspaceId: string;
  pageId: string;
  filename: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
};

const defaultAllowedContentTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "text/plain",
  "application/pdf",
]);

function decodeBase64Utf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sanitizeSvg(svg: string): string {
  const sanitized = svg
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|link|meta|base)\b[\s\S]*?>/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*'[^']*'/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s+style\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+style\s*=\s*'[^']*'/gi, "")
    .replace(/\s+style\s*=\s*[^\s>]+/gi, "")
    .replace(
      /\s+(?:href|xlink:href|src)\s*=\s*"[^"]*(?:javascript:|data:text\/html|data:image\/svg\+xml)[^"]*"/gi,
      "",
    )
    .replace(
      /\s+(?:href|xlink:href|src)\s*=\s*'[^']*(?:javascript:|data:text\/html|data:image\/svg\+xml)[^']*'/gi,
      "",
    )
    .replace(
      /\s+(?:href|xlink:href|src)\s*=\s*[^\s>]*(?:javascript:|data:text\/html|data:image\/svg\+xml)[^\s>]*/gi,
      "",
    )
    .trim();

  if (!/<svg(?:\s|>)/i.test(sanitized)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "SVG attachments must contain an SVG document.",
      400,
    );
  }
  if (
    /<script\b|<foreignObject\b|\son[a-z0-9_-]+\s*=|javascript:/i.test(
      sanitized,
    )
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "SVG attachment contains unsafe active content.",
      400,
    );
  }
  return sanitized;
}

function sanitizeFilename(filename: string): string {
  const parts = filename.trim().split(".");
  const ext = parts.length > 1 ? parts.pop() : "";
  const base = slugifyTitle(parts.join(".") || filename);
  return ext ? `${base}.${ext.toLowerCase().replace(/[^a-z0-9]/g, "")}` : base;
}

export class AttachmentService {
  private readonly attachments = new Map<string, AttachmentRecord>();

  constructor(
    private readonly objectStore: ObjectStore,
    private readonly options: {
      maxAttachmentBytes?: number;
      allowedContentTypes?: Set<string>;
    } = {},
  ) {}

  async upload(input: {
    page: PageRecord;
    filename: string;
    contentType: string;
    base64Body: string;
  }): Promise<AttachmentRecord> {
    const byteSize = Math.ceil((input.base64Body.length * 3) / 4);
    const maxAttachmentBytes =
      this.options.maxAttachmentBytes ?? 10 * 1024 * 1024;
    if (byteSize > maxAttachmentBytes) {
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Attachment exceeds the configured size limit.",
        413,
        {
          max_attachment_bytes: maxAttachmentBytes,
        },
      );
    }
    const allowedContentTypes =
      this.options.allowedContentTypes ?? defaultAllowedContentTypes;
    if (!allowedContentTypes.has(input.contentType)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Attachment content type is not allowed.",
        400,
        {
          content_type: input.contentType,
        },
      );
    }

    let storedBase64Body = input.base64Body;
    let storedByteSize = byteSize;
    if (input.contentType === "image/svg+xml") {
      const sanitizedSvg = sanitizeSvg(decodeBase64Utf8(input.base64Body));
      storedBase64Body = encodeBase64Utf8(sanitizedSvg);
      storedByteSize = new TextEncoder().encode(sanitizedSvg).byteLength;
    }

    const id = createId(idPrefixes.attachment);
    const filename = sanitizeFilename(input.filename);
    const objectKey = input.page.objectKeyCurrent.replace(
      /source\/current\.[a-z]+$/,
      `attachments/${id}/${filename}`,
    );
    await this.objectStore.put(objectKey, storedBase64Body, {
      contentType: input.contentType,
    });

    const attachment: AttachmentRecord = {
      id,
      workspaceId: input.page.workspaceId,
      pageId: input.page.id,
      filename,
      objectKey,
      contentType: input.contentType,
      byteSize: storedByteSize,
      createdAt: new Date().toISOString(),
    };
    this.attachments.set(id, attachment);
    return attachment;
  }

  async get(
    attachmentId: string,
  ): Promise<{ attachment: AttachmentRecord; base64Body: string } | null> {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) return null;
    const object = await this.objectStore.get(attachment.objectKey);
    if (!object) return null;
    return { attachment, base64Body: object.body };
  }

  listForPage(pageId: string): AttachmentRecord[] {
    return [...this.attachments.values()].filter(
      (attachment) => attachment.pageId === pageId,
    );
  }
}
