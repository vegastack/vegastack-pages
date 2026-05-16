// Repository interfaces.
//
// Each interface defines the narrow surface a service needs from
// persistent storage. Today these are satisfied by in-memory adapters
// under apps/web/src/lib/runtime/repos/*. Plan 010 phase 5 replaces
// them with direct-D1 adapters under the same interfaces.

export type * from "./favorite.repo.ts";
export type * from "./page.repo.ts";
export type * from "./comment.repo.ts";
export type * from "./workspace.repo.ts";
export type * from "./template.repo.ts";
export type * from "./attachment.repo.ts";
