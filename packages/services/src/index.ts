// @vegastack/pages-services — application service layer.
//
// Consumed by:
//   - apps/web/src/pages/api/**  (HTTP adapters, thin)
//   - apps/web/src/pages/mcp.ts  (MCP adapter)
//   - packages/mcp               (when MCP moves to its own package)
//
// CLI (Rust) does NOT import this; it speaks HTTP to the backend Worker
// which thin-wraps these same services.
//
// Each service file exports plain async functions:
//   export async function createPage(ctx: ServiceContext, input: NewPage): Promise<{ page: PageRecord; envelope: MutationEnvelope }>;
//
// Services are pure: no module-level state, no global side effects,
// no direct env access. Everything flows through ctx.

export type {
  Actor,
  MutationEnvelope,
  ServiceContext,
  SessionHandle,
  SessionPreparedStatement,
  RepoRegistry,
} from "./context.ts";
export { ServiceError, isServiceError, httpStatusFor } from "./errors.ts";
export type { ServiceErrorCode } from "./errors.ts";
export { buildEnvelope, attachEnvelope, jsonWithEnvelope } from "./envelope.ts";
export type { EnvelopeInput } from "./envelope.ts";

// Repo interfaces. Implementations live in apps/web/src/lib/runtime/repos.
// The interfaces are exported as types so consumers depend on contracts,
// not concrete in-memory or D1 implementations.
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
  PublicationRepo,
  PublicationPermission,
  PublicationRecord,
  PublicationResourceType,
  UpsertPublicationInput,
  UpdatePublicationInput,
} from "./repo/publication.repo.ts";
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

// Application services. Each module exports pure functions over the
// ServiceContext. HTTP adapters (apps/web/src/pages/api/**) and MCP
// adapters (apps/web/src/pages/mcp.ts) consume these directly.
//
// AUTHORIZATION CONTRACT (audit-cycle-3-findings.md F-008):
// Services validate AUTHENTICATION (actor.userId present) and treat
// the actor's identity as truth. They do NOT enforce per-resource
// authorization (workspace role, page access list, publication
// permission). Callers — HTTP routes via resolvePageAccess /
// resolveFolderAccess / permissionService.assert, or MCP via its own
// permission helpers — MUST verify the actor has the required scope
// BEFORE invoking a service mutation. Future v2 work will move this
// check into the services with explicit permission requirements.
export * as favorites from "./favorites.service.ts";
export * as pages from "./pages.service.ts";
export * as comments from "./comments.service.ts";
export * as workspaces from "./workspaces.service.ts";
export * as publications from "./publications.service.ts";
export * as templates from "./templates.service.ts";
export * as attachments from "./attachments.service.ts";
export type { ServiceOutput } from "./pages.service.ts";
export type { CommentMutationResult } from "./comments.service.ts";
export type { WorkspaceMutation } from "./workspaces.service.ts";
export type { PublicationResult } from "./publications.service.ts";
export type { TemplateMutation } from "./templates.service.ts";
export type { AttachmentMutation } from "./attachments.service.ts";

// Service modules will be added incrementally:
//   export * as documents from "./documents.service.ts";
//   export * as mutations from "./mutations.service.ts";
//   export * as comments from "./comments.service.ts";
//   export * as publications from "./publications.service.ts";
//   export * as templates from "./templates.service.ts";
//   export * as workspaces from "./workspaces.service.ts";
//   export * as search from "./search.service.ts";
//   export * as review from "./review.service.ts";
