// Repository registry.
//
// One module-level `repos` object exposes all the per-resource repos so
// route handlers and services can import once and access every repo:
//
//   import { repos } from "../../../lib/runtime/repos";
//   const page = await repos.pages.getById(pageId);
//   await repos.favorites.add({ pageId, userId, workspaceId });
//
// Each repo is currently the in-memory adapter. The D1 implementations
// (apps/web/src/lib/runtime/repos/d1/*) will swap in under the same
// interface when Workstream A's repository rewrite lands. Routes that
// migrate to repos today get the right interface; the implementation
// swap is transparent.
//
// Note: `repos` is module-level state — but unlike the legacy service
// maps it holds NO request-scoped data. It's a registry of adapter
// objects, not a cache of records. Per Cloudflare workers-best-practices
// SKILL.md:74 ("Never store request-scoped data in module-level
// variables") this is the allowed shape.

import { favoriteService } from "../../runtime";
import { createInMemoryAttachmentRepo } from "./attachment.in-memory";
import { createInMemoryCommentRepo } from "./comment.in-memory";
import { createInMemoryFavoriteRepo } from "./favorite.in-memory";
import { createInMemoryPageRepo } from "./page.in-memory";
import { createInMemoryPublicationRepo } from "./publication.in-memory";
import { createInMemoryTemplateRepo } from "./template.in-memory";
import { createInMemoryWorkspaceRepo } from "./workspace.in-memory";

import type {
  AttachmentRepo,
  CommentRepo,
  FavoriteRepo,
  PageRepo,
  PublicationRepo,
  TemplateRepo,
  WorkspaceRepo,
} from "@vegastack/pages-services";

export type Repos = {
  pages: PageRepo;
  favorites: FavoriteRepo;
  comments: CommentRepo;
  workspaces: WorkspaceRepo;
  publications: PublicationRepo;
  templates: TemplateRepo;
  attachments: AttachmentRepo;
};

export const repos: Repos = {
  pages: createInMemoryPageRepo(),
  favorites: createInMemoryFavoriteRepo(favoriteService),
  comments: createInMemoryCommentRepo(),
  workspaces: createInMemoryWorkspaceRepo(),
  publications: createInMemoryPublicationRepo(),
  templates: createInMemoryTemplateRepo(),
  attachments: createInMemoryAttachmentRepo(),
};

// Re-export the suppressed runtime symbol so tests can inspect the
// underlying CommentService if needed. The repos object remains the
// canonical access path for production code.
export { commentService } from "../../runtime";
