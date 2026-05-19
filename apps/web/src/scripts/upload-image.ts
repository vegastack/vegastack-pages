// Client-side image compression for editor uploads. Plan 011 §9.
//
// Compresses images to WebP at quality 0.85 via OffscreenCanvas before
// posting to the /api/pages/[pageId]/attachments endpoint. The native
// OffscreenCanvas + convertToBlob path:
//   - Uses zero JS dependencies
//   - Runs on a Web Worker when available (won't block the editor)
//   - Produces ~5-10x smaller uploads than raw photos
//
// Feature-detects WebP support: Safari (as of 2026-05) supports
// OffscreenCanvas + convertToBlob but not the WebP MIME type — we fall
// back to JPEG at q=0.85 in that case.
//
// Server contract: the route receives the blob as the request body and
// reads `X-Image-Width` / `X-Image-Height` headers to populate the
// `image_width` / `image_height` columns on the `attachments` row. The
// renderer uses those dimensions to emit `<img width=… height=…>` tags
// so the browser reserves layout space pre-load and avoids CLS.

const MAX_IMAGE_DIMENSION = 2000;
const TARGET_QUALITY = 0.85;

export type CompressedImage = {
  blob: Blob;
  width: number;
  height: number;
  mimeType: "image/webp" | "image/jpeg";
};

let cachedWebpSupport: boolean | null = null;

async function detectWebpSupport(): Promise<boolean> {
  if (cachedWebpSupport !== null) return cachedWebpSupport;
  if (typeof OffscreenCanvas === "undefined") {
    cachedWebpSupport = false;
    return false;
  }
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      cachedWebpSupport = false;
      return false;
    }
    const blob = await canvas.convertToBlob({ type: "image/webp" });
    cachedWebpSupport = blob.type === "image/webp";
  } catch {
    cachedWebpSupport = false;
  }
  return cachedWebpSupport;
}

function scaleDimensions(
  width: number,
  height: number,
): { targetWidth: number; targetHeight: number } {
  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    return { targetWidth: width, targetHeight: height };
  }
  const ratio = width / height;
  if (width >= height) {
    const targetWidth = MAX_IMAGE_DIMENSION;
    return {
      targetWidth,
      targetHeight: Math.round(targetWidth / ratio),
    };
  }
  const targetHeight = MAX_IMAGE_DIMENSION;
  return {
    targetWidth: Math.round(targetHeight * ratio),
    targetHeight,
  };
}

// Compress a single image file. Throws if the browser environment is
// missing OffscreenCanvas or createImageBitmap.
export async function compressBeforeUpload(
  file: File,
): Promise<CompressedImage> {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error(
      "OffscreenCanvas is unavailable in this browser. Upload a smaller image or use a modern browser.",
    );
  }
  if (typeof createImageBitmap === "undefined") {
    throw new Error("createImageBitmap is unavailable in this browser.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const { targetWidth, targetHeight } = scaleDimensions(
      bitmap.width,
      bitmap.height,
    );
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("OffscreenCanvas 2D context unavailable.");
    }
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const webpSupported = await detectWebpSupport();
    const mimeType = webpSupported ? "image/webp" : "image/jpeg";
    const blob = await canvas.convertToBlob({
      type: mimeType,
      quality: TARGET_QUALITY,
    });
    return { blob, width: targetWidth, height: targetHeight, mimeType };
  } finally {
    bitmap.close();
  }
}

// Convenience helper: compress + POST in one step. Returns the parsed
// attachment row when the upload succeeds, throws on HTTP error.
export async function uploadCompressedImage(
  pageId: string,
  file: File,
  options: { workspaceId?: string; filename?: string } = {},
): Promise<{
  attachment_id: string;
  object_key: string;
  url: string;
  image_width: number | null;
  image_height: number | null;
}> {
  const compressed = await compressBeforeUpload(file);
  const filename =
    options.filename ??
    `${file.name.replace(/\.[^.]+$/, "")}.${compressed.mimeType === "image/webp" ? "webp" : "jpg"}`;
  const params = new URLSearchParams();
  if (options.workspaceId) params.set("workspace_id", options.workspaceId);
  const url =
    `/api/pages/${encodeURIComponent(pageId)}/attachments` +
    (params.size > 0 ? `?${params.toString()}` : "");
  const response = await fetch(url, {
    method: "POST",
    body: compressed.blob,
    headers: {
      "content-type": compressed.mimeType,
      "x-filename": filename,
      "x-image-width": String(compressed.width),
      "x-image-height": String(compressed.height),
    },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Image upload failed: ${response.status} ${text || response.statusText}`,
    );
  }
  return response.json();
}
