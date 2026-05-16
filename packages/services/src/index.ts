// @vegastack/pages-services — application service layer.
//
// Consumed by:
//   - apps/web/src/pages/api/**  (HTTP adapters, thin)
//   - apps/web/src/pages/mcp.ts  (MCP adapter)
//
// CLI (Rust) does NOT import this; it speaks HTTP to the backend Worker
// which thin-wraps these same services.
//
// Each service file exports plain async functions over ServiceContext.
// Services are pure: no module-level state, no global side effects,
// no direct env access. Everything flows through ctx.

export type {
  Actor,
  MutationEnvelope,
  ServiceContext,
  RepoRegistry,
} from "./context.ts";
export { ServiceError, isServiceError, httpStatusFor } from "./errors.ts";
export type { ServiceErrorCode } from "./errors.ts";
export { buildEnvelope, jsonWithEnvelope } from "./envelope.ts";
export type { EnvelopeInput } from "./envelope.ts";

// Repo interfaces. Implementations live in apps/web/src/lib/runtime/repos.
export type {
  FavoriteRecord,
  FavoriteRepo,
  NewFavorite,
} from "./repo/favorite.repo.ts";
export type {
  PageRecord,
  PageRepo,
  PageVersionRecord,
  PageWithSource,
  CreatePageInput,
  UpdateSourceInput,
  UpdateSourceResult,
  MovePageInput,
  SourceType,
} from "./repo/page.repo.ts";
export type {
  CommentAnchorInput,
  CommentAnchorRecord,
  CommentRepo,
  CommentReplyRecord,
  CommentThreadRecord,
  CommentThreadStatus,
  CommentThreadWithReplies,
  CommentsStats,
  CreateThreadInput,
  ReplyInput,
} from "./repo/comment.repo.ts";
export type {
  WorkspaceRepo,
  WorkspaceRecord,
  WorkspaceRole,
  WorkspaceMemberRecord,
  UserRecord,
  FolderRecord,
  FolderDirection,
  CreateUserInput,
  CreateWorkspaceInput,
  CreateFolderInput,
} from "./repo/workspace.repo.ts";
export type {
  TemplateRepo,
  TemplateRecord,
  TemplateWithSource,
  TemplateBuilderDocument,
  TemplateProperty,
  CreateTemplateInput,
  UpdateTemplateInput,
  RenderTemplateInput,
} from "./repo/template.repo.ts";
export type {
  AttachmentRepo,
  AttachmentRecord,
  AttachmentUploadInput,
} from "./repo/attachment.repo.ts";

// Application services. AUTHORIZATION CONTRACT: services validate
// AUTHENTICATION (actor.userId present). They do NOT enforce
// per-resource authorization — callers (HTTP routes via
// resolvePageAccess / resolveFolderAccess / permissionService.assert,
// MCP via its permission helpers) MUST verify the actor has the
// required scope BEFORE invoking a service mutation.
export * as favorites from "./favorites.service.ts";
export * as pages from "./pages.service.ts";
export * as comments from "./comments.service.ts";
export * as workspaces from "./workspaces.service.ts";
export * as templates from "./templates.service.ts";
export * as attachments from "./attachments.service.ts";
export type { ServiceOutput } from "./pages.service.ts";
export type { CommentMutationResult } from "./comments.service.ts";
export type { WorkspaceMutation } from "./workspaces.service.ts";
export type { TemplateMutation } from "./templates.service.ts";
export type { AttachmentMutation } from "./attachments.service.ts";
