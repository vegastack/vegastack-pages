// Repository registry.
//
// One module-level `repos` object exposes all the per-resource repos
// so route handlers and services can import once and access every
// repo. Each repo is currently the in-memory adapter; plan 010 phase 5
// swaps them for direct-D1 adapters under the same interfaces.
//
// `repos` is module-level state but holds NO request-scoped data —
// it's a registry of adapter objects, not a cache of records.

import { favoriteService } from "../../runtime";
import { createInMemoryAttachmentRepo } from "./attachment.in-memory";
import { createInMemoryCommentRepo } from "./comment.in-memory";
import { createInMemoryFavoriteRepo } from "./favorite.in-memory";
import { createInMemoryPageRepo } from "./page.in-memory";
import { createInMemoryTemplateRepo } from "./template.in-memory";
import { createInMemoryWorkspaceRepo } from "./workspace.in-memory";

import type {
  AttachmentRepo,
  CommentRepo,
  FavoriteRepo,
  PageRepo,
  TemplateRepo,
  WorkspaceRepo,
} from "@vegastack/pages-services";

export type Repos = {
  pages: PageRepo;
  favorites: FavoriteRepo;
  comments: CommentRepo;
  workspaces: WorkspaceRepo;
  templates: TemplateRepo;
  attachments: AttachmentRepo;
};

export const repos: Repos = {
  pages: createInMemoryPageRepo(),
  favorites: createInMemoryFavoriteRepo(favoriteService),
  comments: createInMemoryCommentRepo(),
  workspaces: createInMemoryWorkspaceRepo(),
  templates: createInMemoryTemplateRepo(),
  attachments: createInMemoryAttachmentRepo(),
};
