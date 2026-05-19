// Rate-limit service — direct-D1 token-bucket-style counter keyed by
// caller-supplied identifier (e.g. "magic-link:user@example.test" or
// "ip:1.2.3.4:auth").
//
// Plan 011 §5. Replaces packages/core/src/rate-limit.ts (class-based,
// in-memory Map) with a stateless function over ServiceContext that
// persists counters in the canonical D1 `rate_limits` table so limits
// survive Worker restarts and shard across isolates.
//
// Authorization contract: this service does not perform authorization.
// Callers are expected to pass a `key` that already encodes whatever
// identity/scope dimension they want to throttle on. The service only
// counts; it never throws — callers inspect `ok` and decide whether to
// reject the request (typically with HTTP 429 / AppError RATE_LIMITED).
//
// Concurrency: the count update is a single atomic UPSERT using
// `INSERT ... ON CONFLICT(key) DO UPDATE` with the `excluded.*` alias.
// When the existing row's window has already expired (`reset_at <= now`)
// we restart the window in the same statement, so callers that race
// across the boundary all observe a clean reset.

import { AppError } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

export type RateLimitResult = {
  // true if this call is under the limit and should be allowed.
  ok: boolean;
  // tokens left in the current window after this call (0 when blocked).
  remaining: number;
  // ISO-8601 timestamp when the current window resets.
  resetAt: string;
};

export type CheckInput = {
  key: string;
  limit: number;
  windowMs: number;
};

type RateLimitRow = {
  count: number;
  reset_at: string;
};

export async function check(
  ctx: ServiceContext,
  input: CheckInput,
): Promise<RateLimitResult> {
  const db = requireDb(ctx);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const freshResetIso = new Date(nowMs + input.windowMs).toISOString();

  // Single atomic UPSERT: insert a fresh window if no row exists, else
  // either restart the window (when the stored reset_at has already
  // elapsed) or increment the existing counter. SQLite's `excluded.*`
  // alias exposes the would-be-inserted row inside DO UPDATE.
  await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at, updated_at)
         VALUES (?1, 1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE
             WHEN rate_limits.reset_at <= excluded.updated_at THEN 1
             ELSE rate_limits.count + 1
           END,
           reset_at = CASE
             WHEN rate_limits.reset_at <= excluded.updated_at THEN excluded.reset_at
             ELSE rate_limits.reset_at
           END,
           updated_at = excluded.updated_at`,
    )
    .bind(input.key, freshResetIso, nowIso)
    .run();

  // Read back the post-update state so the response reflects exactly
  // what was persisted (including the case where a concurrent caller
  // already advanced the counter).
  const row = await db
    .prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?1")
    .bind(input.key)
    .first<RateLimitRow>();

  // Defensive: the UPSERT above guarantees a row exists. If something
  // truly went wrong we fail closed (block the request, zero remaining,
  // synthesised reset).
  if (!row) {
    return { ok: false, remaining: 0, resetAt: freshResetIso };
  }

  const remaining = Math.max(0, input.limit - row.count);
  const ok = row.count <= input.limit;
  return {
    ok,
    remaining: ok ? remaining : 0,
    resetAt: row.reset_at,
  };
}

// Convenience wrapper for routes that want a single call that either
// succeeds (under limit) or throws RATE_LIMITED (over limit). Mirrors
// the legacy `checkRateLimit(...)` semantics so routes can collapse
// the `if (!result.ok) throw …` boilerplate.
export async function enforce(
  ctx: ServiceContext,
  input: CheckInput,
): Promise<RateLimitResult> {
  const result = await check(ctx, input);
  if (!result.ok) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      429,
      {
        reset_at: result.resetAt,
        key: input.key,
      },
    );
  }
  return result;
}
