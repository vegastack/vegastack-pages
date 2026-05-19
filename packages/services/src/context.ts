// ServiceContext is the single object passed to every service function.
// It carries the actor identity (already verified by the caller), the
// repository registry the service reads/writes through, a hook to
// compute the workspace navigation hash post-mutation, a hook to
// schedule background work (forwarded to ctx.waitUntil on Cloudflare),
// and a structured logger.
//
// Services NEVER read process.env, NEVER reach Cloudflare runtime
// globals, and NEVER mutate module-level state. Everything they need
// flows through this object.

export type Actor = {
  userId: string;
  email: string | null;
  workspaceId: string | null;
};

// Attached to every nav-affecting POST response so clients can patch
// their caches without polling. tree_version is a string because the
// implementation hashes workspace state (see
// apps/web/src/lib/workspace-navigation.ts); either a hash or a
// monotonic counter would satisfy the contract.
export type MutationEnvelope = {
  tree_version: string;
  content_hash?: string;
  navigation_invalidated: boolean;
  // Stable resource identifiers in `<kind>:<id>` form. Examples:
  //   "page:pg_abc"
  //   "folder:fl_xyz"
  //   "comments_stats:pg_abc"
  //   "favorite:pg_abc:usr_123"
  //   "publication:pub_def"
  //   "permission:workspace:ws_ghi"
  //   "members:ws_ghi"
  changed_resources: string[];
};

import type { D1Database } from "@vegastack/pages-db";
import type { ObjectStore } from "@vegastack/pages-core";
import type { FavoriteRepo } from "./repo/favorite.repo.ts";
import type { PageRepo } from "./repo/page.repo.ts";
import type { CommentRepo } from "./repo/comment.repo.ts";
import type { WorkspaceRepo } from "./repo/workspace.repo.ts";

export type RepoRegistry = {
  pages: PageRepo;
  favorites: FavoriteRepo;
  comments: CommentRepo;
  workspaces: WorkspaceRepo;
};

export type ServiceContext = {
  actor: Actor;
  // Direct D1 handle. Plan 011 §5 migrates every service onto this;
  // `repo` below is the legacy in-memory surface that the four
  // pre-rebuild services (pages, workspaces, comments, favorites)
  // still consume and will be removed once they are rewritten.
  //
  // Marked optional only for the migration window so existing tests
  // (which don't construct a D1) stay green. Services that need it
  // assert presence via `requireDb(ctx)`.
  db?: D1Database;
  // R2 / Node-FS object store. Services that touch page sources,
  // rendered HTML, attachments, or template artifacts use this.
  // Optional for the migration window for the same reason as `db`.
  objectStore?: ObjectStore;
  // Legacy in-memory repo registry. No service still consumes it;
  // retained as optional to keep the type backward-compatible with any
  // callers that still pass it through. Will be removed entirely once
  // every consumer drops the field.
  repo?: RepoRegistry;
  // Computes the workspace navigation hash from the CURRENT (post-write)
  // state. Services call this AFTER applying a mutation so the
  // envelope's tree_version reflects what the client should now
  // invalidate.
  computeTreeVersion(workspaceId: string): Promise<string>;
  // Register non-critical post-response work. On Cloudflare this is
  // ctx.waitUntil; on Node it runs the promise and logs rejections.
  waitUntil(promise: Promise<unknown>): void;
  // Structured logger.
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  // Public origin (e.g. "https://pages.vegastack.com"). Set by route
  // handlers from `new URL(request.url).origin` so services that need
  // to purge the Cloudflare edge cache (publishFanOut, publications.
  // revoke, etc.) can compute the canonical public URL without each
  // route having to thread the origin through their function calls.
  publicOrigin?: string;
};

export function requireDb(ctx: ServiceContext): D1Database {
  if (!ctx.db) {
    throw new Error(
      "ServiceContext.db is required by this service. Construct the context with a D1Database.",
    );
  }
  return ctx.db;
}

export function requireObjectStore(ctx: ServiceContext): ObjectStore {
  if (!ctx.objectStore) {
    throw new Error(
      "ServiceContext.objectStore is required by this service. Construct the context with an ObjectStore.",
    );
  }
  return ctx.objectStore;
}
