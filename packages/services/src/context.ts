// ServiceContext is the single object passed to every service method.
// It carries the actor identity (already verified by the caller), the
// runtime environment (Cloudflare bindings or Node shims), a way to
// register background work (ctx.waitUntil on CF; immediate fire-and-
// forget on Node), and an opaque session handle for D1 read-after-
// write consistency.
//
// Services NEVER read process.env, NEVER reach into Cloudflare runtime
// globals, and NEVER mutate module-level state. Everything they need
// flows through this object.

export type Actor = {
  userId: string;
  email: string | null;
  workspaceId: string | null;
  // Permissions are resolved per call from the database; this struct
  // intentionally does not carry pre-computed scopes.
};

// The mutation envelope is attached to every nav-affecting POST response.
// Clients use it to decide what to invalidate without polling: the shell
// controller compares tree_version against its cached copy and refetches
// the sidebar if changed; it patches per-resource caches based on
// changed_resources entries.
//
// tree_version is a string because the existing implementation (see
// apps/web/src/lib/workspace-navigation.ts:174) computes a deterministic
// content hash keyed by workspace state, not a monotonic integer. Either
// representation is fine for invalidation; the contract is just "the
// value changes when the tree shape changes."
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

// Opaque session handle. On Cloudflare, this wraps env.DB.withSession
// and exposes the latest bookmark. On Node (single-writer SQLite),
// this is a no-op pass-through and bookmark is always null.
export type SessionHandle = {
  readonly bookmark: string | null;
  prepare(sql: string): SessionPreparedStatement;
  batch(statements: SessionPreparedStatement[]): Promise<unknown[]>;
};

export type SessionPreparedStatement = {
  bind(...values: unknown[]): SessionPreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
  raw<T = unknown[]>(): Promise<T[]>;
};

// Strongly-typed repository registry. Implementations live in
// apps/web/src/lib/runtime/repos and satisfy these interfaces. Services
// consume the registry via ctx.repo.*; never reach into module-level
// state for storage.

import type { FavoriteRepo } from "./repo/favorite.repo.ts";
import type { PageRepo } from "./repo/page.repo.ts";
import type { CommentRepo } from "./repo/comment.repo.ts";
import type { WorkspaceRepo } from "./repo/workspace.repo.ts";
import type { PublicationRepo } from "./repo/publication.repo.ts";
import type { TemplateRepo } from "./repo/template.repo.ts";
import type { AttachmentRepo } from "./repo/attachment.repo.ts";

export type RepoRegistry = {
  pages: PageRepo;
  favorites: FavoriteRepo;
  comments: CommentRepo;
  workspaces: WorkspaceRepo;
  publications: PublicationRepo;
  templates: TemplateRepo;
  attachments: AttachmentRepo;
};

export type ServiceContext = {
  actor: Actor;
  session: SessionHandle;
  repo: RepoRegistry;
  // Computes the workspace navigation hash from the CURRENT (post-write)
  // state. Services call this AFTER applying a mutation so the envelope's
  // tree_version reflects what the client should now invalidate. The
  // explicit workspaceId argument keeps semantics unambiguous when the
  // mutation targets a workspace different from the actor's default.
  computeTreeVersion(workspaceId: string): Promise<string>;
  // Register non-critical post-response work. On Cloudflare this is
  // ctx.waitUntil; on Node it runs the promise and logs rejections.
  waitUntil(promise: Promise<unknown>): void;
  // Structured logger. Implementation injected by the adapter.
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void;
};
