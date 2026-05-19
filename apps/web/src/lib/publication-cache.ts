// Public-read fast path — Cache API + R2 artifact serving.
//
// Plan 011 §7-§8 / Plan 012 Phase G. When a request hits /p/[slug] or
// /f/[slug] anonymously (no `vpg_session` cookie / no bearer), AND the
// publication has a baked artifact in R2, we serve that artifact
// directly without re-rendering. The full Astro SSR path stays as the
// fallback for member views, race-recovery (artifact missing), and
// password-gated publications where the prompt UI must render.
//
// The artifact at `pub/{publicationId}/{contentHash}.html` was written
// by `publishFanOut` in packages/services/src/publications.service.ts
// at save time. So this read path is a pure stream: Cache API → R2 →
// response (with ETag, Cache-Control, Vary).

import type { AstroCookies } from "astro";
import type {
  PublicationPermission,
  PublicationRecord,
} from "@vegastack/pages-core";
import type { ServiceContext } from "@vegastack/pages-services";
import { publications as publicationsService } from "@vegastack/pages-services";

// ---------------------------------------------------------------------------
// Cache-Control matrix (per Plan 011 §8).
// ---------------------------------------------------------------------------

export function computeCacheControl(input: {
  passwordHash: string | null;
  indexingEnabled: boolean;
}): { value: string; vary?: string } {
  if (input.passwordHash) {
    return { value: "private, max-age=60", vary: "Cookie" };
  }
  if (input.indexingEnabled) {
    return {
      value:
        "public, max-age=300, s-maxage=31536000, stale-while-revalidate=60",
    };
  }
  return {
    value: "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
  };
}

// ETag combines the artifact's content_hash + the publication's
// updated_at + the password state. Any of the three changing busts the
// cache without us having to purge by URL. Weak ETag (`W/"…"`) because
// the bytes can vary slightly across compression / origin.
export function computeArtifactEtag(input: {
  contentHash: string;
  updatedAt: string;
  passwordGated: boolean;
}): string {
  const stamp = Date.parse(input.updatedAt);
  return `W/"${input.contentHash}.${Number.isFinite(stamp) ? stamp.toString(36) : "x"}.${input.passwordGated ? "p" : "o"}"`;
}

// ---------------------------------------------------------------------------
// Cache global accessor — Cloudflare exposes `caches.default`, Node does
// not. Reading through a typed cast avoids polluting the cross-runtime
// type surface.
// ---------------------------------------------------------------------------

export function getEdgeCache(): Cache | undefined {
  const global = globalThis as unknown as {
    caches?: { default?: Cache };
  };
  return global.caches?.default;
}

// ---------------------------------------------------------------------------
// Public-anonymous detection — we only serve from the artifact when:
//   • there's no signed-in user (no session cookie, no bearer)
//   • there's no member-view url param like ?member=1
// Otherwise the route falls through to the full SSR path so the actor
// sees their sidebar / comments / member chrome.
// ---------------------------------------------------------------------------

export function isAnonymousPublicRequest(
  cookies: AstroCookies | undefined,
): boolean {
  if (!cookies || typeof cookies.get !== "function") return true;
  if (cookies.get("vpg_session")?.value) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Password gating — verify the per-publication password cookie.
// ---------------------------------------------------------------------------

export function publicationPasswordCookieName(publicationId: string): string {
  return `vpg_pub_${publicationId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function expectedPasswordCookieValue(
  publication: PublicationRecord,
): Promise<string> {
  return sha256(
    `v1:${publication.id}:${publication.passwordHash ?? ""}:${publication.updatedAt}`,
  );
}

export async function verifyPasswordCookie(
  cookies: AstroCookies,
  publication: PublicationRecord,
): Promise<boolean> {
  if (!publication.passwordHash) return true;
  const cookieValue = cookies.get(
    publicationPasswordCookieName(publication.id),
  )?.value;
  if (!cookieValue) return false;
  const expected = await expectedPasswordCookieValue(publication);
  return constantTimeEqual(cookieValue, expected);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Comments-island gating — publications with `comment` or `edit`
// permission emit the lazy client-side comments island. View-only
// publications don't.
// ---------------------------------------------------------------------------

export function publicationAllowsComments(
  permission: PublicationPermission,
): boolean {
  return permission === "comment" || permission === "edit";
}

// ---------------------------------------------------------------------------
// Fast-path response builder — wraps the R2 artifact in a minimal
// public shell (no member sidebar). The shell is intentionally tiny: a
// shared header, the baked HTML, and (optionally) the comments island.
// The full app-shell path remains in /p/[slug].astro for member views.
// ---------------------------------------------------------------------------

export type PublishedArtifactResponse = {
  response: Response;
  fromCache: boolean;
};

export type ServePublishedArtifactInput = {
  ctx: ServiceContext;
  publication: PublicationRecord;
  request: Request;
  // Public origin for the canonical URL. Defaults to request URL origin.
  publicOrigin?: string;
};

// Render a thin public HTML shell around the baked artifact. Keeps the
// markup small (no per-user state, no client islands beyond optional
// comments) so the response is byte-identical across anonymous visitors
// and the edge cache hits hard.
function renderPublicShell(input: {
  publication: PublicationRecord;
  artifactHtml: string;
  showComments: boolean;
  title: string;
  description?: string | null;
  canonicalUrl: string;
}): string {
  const safeTitle = escapeHtml(input.title);
  const safeDescription = input.description
    ? escapeHtml(input.description)
    : "";
  const robots = input.publication.indexingEnabled
    ? "index, follow"
    : "noindex, nofollow";
  const commentsIsland = input.showComments
    ? `<comments-island
        data-publication-id="${escapeHtml(input.publication.id)}"
        data-resource-type="${escapeHtml(input.publication.resourceType)}"
        data-resource-id="${escapeHtml(input.publication.resourceId)}"
        data-permission="${escapeHtml(input.publication.permission)}"
      ></comments-island>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${robots}">
${safeDescription ? `<meta name="description" content="${safeDescription}">` : ""}
<link rel="canonical" href="${escapeHtml(input.canonicalUrl)}">
<link rel="stylesheet" href="/_astro/docs.css" media="all">
</head>
<body class="vpg-public-shell">
<main class="vpg-public-article">
${input.artifactHtml}
</main>
${commentsIsland}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Serve a publication artifact through Cache API + R2. Returns null if
// the artifact isn't available (caller should fall back to SSR).
export async function servePublishedArtifact(
  input: ServePublishedArtifactInput,
): Promise<PublishedArtifactResponse | null> {
  const { ctx, publication, request } = input;
  if (!publication.latestArtifactKey || !publication.latestContentHash) {
    return null;
  }

  const url = new URL(request.url);
  const cacheKey = new Request(url.toString(), {
    method: "GET",
    headers: request.headers,
  });
  const edgeCache = getEdgeCache();

  // 1. Edge cache fast path (Cloudflare colo cache).
  if (edgeCache) {
    const cached = await edgeCache.match(cacheKey);
    if (cached) {
      return { response: cached, fromCache: true };
    }
  }

  // 2. R2 artifact read.
  const objectStore = ctx.objectStore;
  if (!objectStore) return null;
  const artifact = await objectStore.get(publication.latestArtifactKey);
  if (!artifact) return null;

  const passwordGated = Boolean(publication.passwordHash);
  const etag = computeArtifactEtag({
    contentHash: publication.latestContentHash,
    updatedAt: publication.latestRenderedAt ?? publication.updatedAt,
    passwordGated,
  });

  // 3. ETag-based 304.
  if (request.headers.get("if-none-match") === etag) {
    const cacheControl = computeCacheControl({
      passwordHash: publication.passwordHash,
      indexingEnabled: publication.indexingEnabled,
    });
    return {
      response: new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": cacheControl.value,
          ...(cacheControl.vary ? { vary: cacheControl.vary } : {}),
        },
      }),
      fromCache: false,
    };
  }

  // 4. Build the response. The artifact body is the rendered HTML; we
  // wrap it in the minimal public shell.
  const html = renderPublicShell({
    publication,
    artifactHtml: artifact.body,
    showComments: publicationAllowsComments(publication.permission),
    title: publication.resourceType === "folder" ? "Folder" : "Page",
    canonicalUrl: url.toString(),
  });
  const cacheControl = computeCacheControl({
    passwordHash: publication.passwordHash,
    indexingEnabled: publication.indexingEnabled,
  });
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    etag,
    "cache-control": cacheControl.value,
  });
  if (cacheControl.vary) headers.set("vary", cacheControl.vary);
  if (!publication.indexingEnabled) {
    headers.set("x-robots-tag", "noindex, nofollow");
  }

  const response = new Response(html, { headers });

  // 5. Write back to edge cache so the next anonymous visitor hits
  // step 1. Done via waitUntil so the response isn't held.
  if (edgeCache) {
    const cloned = response.clone();
    const cfWaitUntil = (
      globalThis as unknown as {
        __vpgWaitUntil?: (p: Promise<unknown>) => void;
      }
    ).__vpgWaitUntil;
    const persist = edgeCache.put(cacheKey, cloned);
    if (cfWaitUntil) {
      cfWaitUntil(persist);
    } else {
      void persist.catch((err) => {
        console.warn("[vpg-publication-cache] cache.put failed:", err);
      });
    }
  }

  return { response, fromCache: false };
}

// ---------------------------------------------------------------------------
// Cache invalidation — called from publishFanOut (via the route layer
// that triggers it) after a publication's artifact is rewritten.
// ---------------------------------------------------------------------------

export async function invalidatePublicationCache(input: {
  publication: PublicationRecord;
  slug: string;
  publicOrigin: string;
}): Promise<void> {
  const edgeCache = getEdgeCache();
  if (!edgeCache) return;
  const path =
    input.publication.resourceType === "folder"
      ? `/f/${input.slug}`
      : `/p/${input.slug}`;
  await edgeCache.delete(new Request(`${input.publicOrigin}${path}`));
}

// ---------------------------------------------------------------------------
// Race-recovery: publication exists but the artifact is missing. Trigger
// a re-fan-out and return null (caller falls back to SSR).
// ---------------------------------------------------------------------------

export async function republishOnDemand(input: {
  ctx: ServiceContext;
  publication: PublicationRecord;
  pageId: string;
  contentHash: string;
}): Promise<void> {
  try {
    await publicationsService.publishFanOut(input.ctx, {
      publicationId: input.publication.id,
      workspaceId: input.publication.workspaceId,
      pageId: input.pageId,
      contentHash: input.contentHash,
    });
  } catch (error) {
    input.ctx.log("warn", "publication-cache.republishOnDemand.failed", {
      publication_id: input.publication.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
