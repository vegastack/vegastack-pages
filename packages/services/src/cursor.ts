// Shared cursor encoding for paginated list endpoints.
//
// Every paginated list orders by (updated_at DESC, id ASC) so the
// cursor needs exactly those two fields to resume deterministically
// across pages even when rows share the same updated_at timestamp.
// The encoded cursor is URL-safe base64 of `${updated_at}|${id}` —
// opaque to callers, never parsed by anything other than `decodeCursor`.

export type ListCursor = {
  updatedAt: string;
  id: string;
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ListPageOptions = {
  // Page size. Clamped to [1, hardCap] by each service.
  limit?: number;
  // Opaque cursor from a previous response's `nextCursor`.
  cursor?: string;
};

// Encode `(updated_at, id)` into the opaque cursor token. Returns null
// when the input page is the last — callers should stop following the
// cursor at that point. Uses URL-safe base64 (no padding) so the token
// can be passed through query strings without re-encoding.
export function encodeCursor(value: ListCursor | null): string | null {
  if (!value) return null;
  const raw = `${value.updatedAt}|${value.id}`;
  // btoa exists in Workers + Node 22+; matches the encoding used by
  // OAuth codes throughout the codebase.
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode a cursor token back into `(updated_at, id)`. Returns null on
// malformed input — callers should treat a malformed cursor as "no
// cursor" rather than throw, so a corrupted query string can't 500
// the route. Tampering doesn't grant access (the cursor only changes
// where the page starts, never what's visible).
export function decodeCursor(
  token: string | null | undefined,
): ListCursor | null {
  if (!token) return null;
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const pipeIndex = decoded.lastIndexOf("|");
    if (pipeIndex <= 0 || pipeIndex === decoded.length - 1) return null;
    const updatedAt = decoded.slice(0, pipeIndex);
    const id = decoded.slice(pipeIndex + 1);
    if (!updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

// Clamp a caller-supplied limit. Centralized so every paginated
// service uses the same defaults + ceiling and the audit findings
// stay consistent.
export function clampLimit(
  limit: number | undefined,
  defaults: { default: number; hardCap: number },
): number {
  const raw = Number(limit ?? defaults.default);
  if (!Number.isFinite(raw)) return defaults.default;
  return Math.min(defaults.hardCap, Math.max(1, Math.floor(raw)));
}
