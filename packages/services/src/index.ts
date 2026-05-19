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
export { requireDb, requireObjectStore } from "./context.ts";
export { ServiceError, isServiceError, httpStatusFor } from "./errors.ts";
export type { ServiceErrorCode } from "./errors.ts";
export { buildEnvelope, jsonWithEnvelope } from "./envelope.ts";
export type { EnvelopeInput } from "./envelope.ts";
export { encodeCursor, decodeCursor, clampLimit } from "./cursor.ts";
export type { ListCursor, ListPageOptions, PaginatedResult } from "./cursor.ts";

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
export * as setup from "./setup.service.ts";
export * as users from "./users.service.ts";
export * as folders from "./folders.service.ts";
export * as auth from "./auth.service.ts";
export * as rateLimit from "./rate-limit.service.ts";
export * as audit from "./audit.service.ts";
export * as reviewEvents from "./review-events.service.ts";
export * as attachments from "./attachments.service.ts";
export * as permissions from "./permissions.service.ts";
export * as publications from "./publications.service.ts";
export * as mcpSessions from "./mcp-sessions.service.ts";
export type {
  AgentSessionKind,
  AgentSessionRecord,
  McpSessionRecord,
} from "./mcp-sessions.service.ts";
export * as templates from "./templates.service.ts";
export * as search from "./search.service.ts";
export type {
  PermissionGrant,
  PermissionScope,
  PermissionLevel,
} from "./permissions.service.ts";
export type {
  PublicationRecord,
  PublicationPermission,
  PublicationResourceType,
} from "./publications.service.ts";
export type { AuditLogRecord } from "./audit.service.ts";
export type { ReviewEventRecord } from "./review-events.service.ts";
export type {
  AttachmentRecord,
  UploadAttachmentInput,
} from "./attachments.service.ts";
export type {
  TemplateRecord,
  TemplateVersionRecord,
  TemplateSourceType,
  TemplateWithSource,
  CreateTemplateInput,
  UpdateTemplateInput,
  RenderInput as RenderTemplateInput,
  RenderResult as RenderTemplateResult,
} from "./templates.service.ts";
export type { ServiceOutput } from "./pages.service.ts";
export type { CommentMutationResult } from "./comments.service.ts";
export type { WorkspaceMutation } from "./workspaces.service.ts";
