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

import type { FavoriteRepo } from "./repo/favorite.repo.ts";
import type { PageRepo } from "./repo/page.repo.ts";
import type { CommentRepo } from "./repo/comment.repo.ts";
import type { WorkspaceRepo } from "./repo/workspace.repo.ts";
import type { TemplateRepo } from "./repo/template.repo.ts";
import type { AttachmentRepo } from "./repo/attachment.repo.ts";

export type RepoRegistry = {
  pages: PageRepo;
  favorites: FavoriteRepo;
  comments: CommentRepo;
  workspaces: WorkspaceRepo;
  templates: TemplateRepo;
  attachments: AttachmentRepo;
};

export type ServiceContext = {
  actor: Actor;
  repo: RepoRegistry;
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
};
