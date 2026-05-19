// VegaStack Pages image proxy.
//
// Serves attachment objects from R2 with immutable edge caching. Pages
// 011 §9. Keys are content-addressed (`attachments/{workspaceId}/{sha256}.webp`),
// so `Cache-Control: public, max-age=31536000, immutable` is safe — the
// URL changes whenever the bytes change.
//
// Access policy: public proxy. Attachment object keys are unguessable
// (sha256 of the content), so there is no separate access check; if the
// caller knows the URL, they have the bytes. Publications that gate
// access at the page level can choose not to expose attachment URLs to
// non-members; that's an editor concern, not a proxy concern.
//
// Binary fidelity: the public `ObjectStore` facade exposes `body` as a
// string and is therefore unsuitable for images. We reach for the
// R2-bucket binding directly via `getRuntimeBindings()` so the stream
// stays raw bytes. On Node-mode local dev there is no R2 binding; the
// route falls back to the Node FS object-store and reads bytes through
// `node:fs`.

import type { APIRoute } from "astro";
import { getObjectStore, getRuntimeBindings } from "../../lib/runtime";

export const prerender = false;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function inferContentType(
  key: string,
  stored: string | null | undefined,
): string {
  if (stored && stored !== "application/octet-stream") return stored;
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "ico":
      return "image/x-icon";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export const GET: APIRoute = async ({ params, request, locals }) => {
  const rawKey = params.key;
  const key = Array.isArray(rawKey) ? rawKey.join("/") : (rawKey ?? "");
  if (!key.startsWith("attachments/")) {
    return new Response("Not found", { status: 404 });
  }
  // Reject path-traversal attempts. R2 treats slashes as literal bytes,
  // but the Node FS fallback (objectStore.get) calls into the local
  // filesystem and would resolve `..`. Block null bytes too.
  if (key.includes("..") || key.includes("\0")) {
    return new Response("Not found", { status: 404 });
  }

  // Try the edge cache first. On Cloudflare this hits the colo cache;
  // on Node there's no `caches` global.
  const cacheKey = new Request(request.url, request);
  // The Cloudflare runtime exposes `caches.default`; the Web platform's
  // CacheStorage type doesn't model that field, so we read it through a
  // typed cast. On Node the global is undefined.
  const cacheGlobal = (
    globalThis as unknown as {
      caches?: { default?: Cache };
    }
  ).caches;
  const cacheStore: Cache | undefined = cacheGlobal?.default;
  if (cacheStore) {
    const cached = await cacheStore.match(cacheKey);
    if (cached) return cached;
  }

  // Prefer the raw R2 binding so we forward binary bytes. Falls back to
  // the text-based ObjectStore on Node where R2 isn't bound — Node-mode
  // dev environments typically host text-only content so the string
  // round-trip is acceptable for local testing.
  const bindings = await getRuntimeBindings();
  const r2 = (
    bindings as {
      CONTENT?: {
        get(key: string): Promise<{
          body: ReadableStream | null;
          httpMetadata?: { contentType?: string };
          etag?: string;
          httpEtag?: string;
        } | null>;
      };
    } | null
  )?.CONTENT;

  if (r2) {
    const obj = await r2.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    const contentType = inferContentType(
      key,
      obj.httpMetadata?.contentType ?? null,
    );
    const etag = obj.httpEtag ?? obj.etag ?? `"${key}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": IMMUTABLE_CACHE },
      });
    }
    const headers = new Headers({
      "content-type": contentType,
      "cache-control": IMMUTABLE_CACHE,
      etag,
    });
    const response = new Response(obj.body, { headers });
    if (cacheStore) {
      const cfContext = (
        locals as {
          cfContext?: { waitUntil?: (p: Promise<unknown>) => void };
        }
      ).cfContext;
      if (cfContext?.waitUntil) {
        cfContext.waitUntil(cacheStore.put(cacheKey, response.clone()));
      } else {
        void cacheStore.put(cacheKey, response.clone()).catch((err) => {
          console.warn("[vpg-img] cache.put failed:", err);
        });
      }
    }
    return response;
  }

  // Node-mode fallback (no R2 binding). Reads the text-encoded body via
  // the standard ObjectStore facade. Sufficient for local development.
  const objectStore = await getObjectStore();
  const obj = await objectStore.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const contentType = inferContentType(key, obj.contentType ?? null);
  const etag = `"${key}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": IMMUTABLE_CACHE },
    });
  }
  return new Response(obj.body, {
    headers: {
      "content-type": contentType,
      "cache-control": IMMUTABLE_CACHE,
      etag,
    },
  });
};
