// Repository interfaces.
//
// Each interface defines the narrow surface a service needs from
// persistent storage. Two implementations satisfy each interface:
//
//   1. apps/web/src/lib/runtime/repos/*  — in-memory adapters that wrap
//      the existing FavoriteService/PageService/etc. in-memory maps.
//      Used today and during the Task A transition.
//
//   2. apps/web/src/lib/runtime/repos/d1/*  — direct-D1 adapters that
//      issue narrow SQL statements per operation. The end-state.
//
// Both must be async because the D1 implementation is necessarily async.
// In-memory adapters resolve immediately via Promise.resolve.
//
// Plan: docs/plans/007-instant-workspace-architecture.md §4 (Workstream A).

export type * from "./favorite.repo.ts";
export type * from "./page.repo.ts";
export type * from "./comment.repo.ts";
export type * from "./workspace.repo.ts";
export type * from "./publication.repo.ts";
export type * from "./template.repo.ts";
export type * from "./attachment.repo.ts";
