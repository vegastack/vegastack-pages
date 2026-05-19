// Access — actor authentication + permission resolution + publication
// access enforcement. Plan 011 §4 (no legacy singletons). Every helper
// goes through the new D1-direct services in `@vegastack/pages-services`.
//
// All helpers are async because D1 reads are async. Callers in .astro
// files were already inside async SSR contexts, and route handlers
// already awaited the actor-resolver, so the conversion is a one-line
// `await` insertion at most call sites.

import {
  AppError,
  type FolderRecord,
  hasPermission,
  type PageRecord,
  type PermissionLevel,
  permissionLevels,
  permissionForPublication,
  type PermissionRecord,
  type PublicationRecord,
  type UserRecord,
} from "@vegastack/pages-core";
import type { AstroCookies } from "astro";
import {
  audit,
  auth,
  folders as foldersService,
  mcpSessions,
  permissions as permissionsService,
  publications as publicationsService,
  users as usersService,
  workspaces as workspacesService,
  type ServiceContext,
} from "@vegastack/pages-services";
import { parseBearerToken } from "./csrf";
import { getDb } from "./runtime";
import { devAutoLoginUser } from "./dev-auth";

export type RequestActor = {
  user: UserRecord | null;
  sessionId: string | null;
  devFallback: boolean;
  workspaceId: string | null;
  authMode: "session" | "mcp_session" | "anonymous";
};

export type PageAccess = {
  actor: RequestActor;
  permission: PermissionLevel;
  publicationId: string | null;
  publication: PublicationRecord | null;
  guestNameRequired: boolean;
};

// Coerce the services-package UserRecord (displayName: string | null) to
// the legacy core UserRecord (displayName: string) by falling back to
// the email when null. Keeps every consumer's contract intact without
// cascading nullability changes through ~30 files.
type ServiceUser = Awaited<ReturnType<typeof usersService.getById>>;
function toLegacyUser(user: NonNullable<ServiceUser>): UserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// Throwaway service context for read-only D1 calls from access.ts.
// Routes use buildServiceContext() for full ctx including envelope +
// waitUntil; access.ts helpers only need actor + db.
function readOnlyCtx(actor: RequestActor | null): ServiceContext {
  return {
    actor: {
      userId: actor?.user?.id ?? "",
      email: actor?.user?.email ?? null,
      workspaceId: actor?.workspaceId ?? null,
    },
    async computeTreeVersion() {
      return "";
    },
    waitUntil(promise) {
      void promise.catch(() => undefined);
    },
    log(level, message, fields) {
      const emit =
        level === "error" || level === "warn" ? console.error : console.log;
      emit(`[vpg-access] [${level}] ${message}`, fields ?? {});
    },
  };
}

async function withDb<T>(
  actor: RequestActor | null,
  fn: (ctx: ServiceContext) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  const ctx = readOnlyCtx(actor);
  if (db) ctx.db = db;
  return fn(ctx);
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function publicationPasswordCookieName(publicationId: string) {
  return `vpg_pub_${publicationId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export async function publicationPasswordCookieValue(input: {
  id: string;
  passwordHash: string | null;
  updatedAt: string;
}) {
  return sha256(
    `v1:${input.id}:${input.passwordHash ?? ""}:${input.updatedAt}`,
  );
}

export function jsonAppError(error: unknown, fallbackMessage: string) {
  if (error instanceof AppError) {
    return Response.json(error.toJSON(), { status: error.status });
  }
  console.error(fallbackMessage, error);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: fallbackMessage } },
    { status: 500 },
  );
}

export function requiredWorkspaceIdFromUrl(url: URL) {
  const workspaceId = url.searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspaceId) {
    throw new AppError(
      "WORKSPACE_REQUIRED",
      "workspace_id is required for this API request.",
      400,
      {
        parameter: "workspace_id",
        location: "query",
        hint: "Pass workspace_id for every workspace-scoped API call.",
      },
    );
  }
  return workspaceId;
}

export function assertApiWorkspaceId(input: { url: URL; workspaceId: string }) {
  if (!input.url.pathname.startsWith("/api/")) return;
  const received = requiredWorkspaceIdFromUrl(input.url);
  if (received !== input.workspaceId) {
    throw new AppError(
      "PERMISSION_DENIED",
      "workspace_id does not match this resource.",
      403,
      {
        parameter: "workspace_id",
        location: "query",
        received_workspace_id: received,
        hint: "Use the workspace_id returned with the page, folder, template, or publication.",
      },
    );
  }
}

export async function getRequestActor(
  cookies: AstroCookies | undefined,
): Promise<RequestActor> {
  const sessionId =
    typeof cookies?.get === "function"
      ? (cookies.get("vpg_session")?.value ?? null)
      : null;
  if (sessionId) {
    const session = await withDb(null, (ctx) =>
      auth.getSession(ctx, sessionId),
    );
    if (session) {
      const sessionUser = await withDb(null, (ctx) =>
        usersService.getById(ctx, session.userId),
      );
      if (sessionUser) {
        return {
          user: toLegacyUser(sessionUser),
          sessionId,
          devFallback: false,
          workspaceId: null,
          authMode: "session",
        };
      }
    }
  }
  const devUser = await devAutoLoginUser();
  if (devUser) {
    return {
      user: devUser,
      sessionId: null,
      devFallback: true,
      workspaceId: null,
      authMode: "session",
    };
  }
  return {
    user: null,
    sessionId: null,
    devFallback: false,
    workspaceId: null,
    authMode: "anonymous",
  };
}

function bearerToken(request: Request | undefined) {
  if (!request) return "";
  // Delegate to the shared parser so the CSRF bypass and the auth
  // resolver share one definition of "this request carries a Bearer
  // token." Returns "" when no Bearer is present so legacy callers that
  // pattern-match on falsy strings keep working.
  return parseBearerToken(request) ?? "";
}

export async function getApiRequestActor(
  cookies: AstroCookies | undefined,
  request?: Request,
): Promise<RequestActor> {
  const bearer = bearerToken(request);
  if (bearer) {
    // Stored session id is `mcp_${sha256(rawToken)}`; the bearer header
    // carries the raw token, so hash it before the D1 lookup. Legacy
    // pre-hash session ids (`ses_…`) are still looked up by the raw
    // value for backwards-compatibility.
    const bearerSessionId = `mcp_${await sha256(bearer)}`;
    let session = await withDb(null, (ctx) =>
      mcpSessions.findByBearerToken(ctx, bearerSessionId),
    );
    if (!session) {
      session = await withDb(null, (ctx) =>
        mcpSessions.findByBearerToken(ctx, bearer),
      );
    }
    if (session) {
      const user = await withDb(null, (ctx) =>
        usersService.getById(ctx, session.userId ?? ""),
      );
      if (user) {
        const origin = request?.headers.get("origin") ?? undefined;
        if (session.agentSessionId) {
          void withDb(null, (ctx) =>
            mcpSessions.touchAgentSession(ctx, {
              sessionId: session.agentSessionId!,
              origin,
            }),
          ).catch(() => undefined);
        }
        return {
          user: toLegacyUser(user),
          sessionId: session.id,
          devFallback: false,
          workspaceId: session.workspaceId,
          authMode: "mcp_session",
        };
      }
    }
    throw new AppError("AUTH_REQUIRED", "Invalid bearer token.", 401);
  }
  return getRequestActor(cookies);
}

// Folder ancestor record list. Used by permissions resolution: each
// folder in the chain may carry its own grant level.
async function folderAncestorRecordsForPage(
  page: PageRecord,
): Promise<FolderRecord[]> {
  if (!page.folderPath) return [];
  const records = await withDb(null, async (ctx) => {
    const allFolders = await foldersService.listAll(ctx, {
      workspaceId: page.workspaceId,
    });
    // Folders are stored with a leading "/"; page.folderPath strips it.
    // Normalize both sides to the leading-slash form before mapping.
    const normalized = page.folderPath.startsWith("/")
      ? page.folderPath
      : `/${page.folderPath}`;
    const byPath = new Map(allFolders.map((folder) => [folder.path, folder]));
    const folder = byPath.get(normalized);
    if (!folder) return [];
    const ids = await foldersService.ancestorPath(ctx, folder.id);
    const byId = new Map(allFolders.map((folder) => [folder.id, folder]));
    return ids
      .map((id) => byId.get(id))
      .filter((record): record is FolderRecord => Boolean(record));
  });
  return records;
}

async function folderAncestorRecordsForFolder(
  folder: FolderRecord,
): Promise<FolderRecord[]> {
  return withDb(null, async (ctx) => {
    const ids = await foldersService.ancestorPath(ctx, folder.id);
    const records: FolderRecord[] = [];
    for (const id of ids) {
      const record = await foldersService.get(ctx, id);
      if (record) records.push(record);
    }
    return records;
  });
}

// Back-compat wrappers — many existing callers consume the id-only
// shape from the legacy folder-ancestors API.
export async function folderAncestorIdsForPage(
  page: PageRecord,
): Promise<string[]> {
  const records = await folderAncestorRecordsForPage(page);
  return records.map((ancestor) => ancestor.id);
}

export async function folderAncestorIdsForFolder(
  folder: FolderRecord,
): Promise<string[]> {
  const records = await folderAncestorRecordsForFolder(folder);
  return records.map((ancestor) => ancestor.id);
}

export async function resolveActorPermission(input: {
  actor: RequestActor;
  page: PageRecord;
}): Promise<PermissionLevel> {
  if (
    input.actor.workspaceId &&
    input.actor.workspaceId !== input.page.workspaceId
  ) {
    return "none";
  }
  return withDb(input.actor, async (ctx) => {
    const member = input.actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId: input.page.workspaceId,
          userId: input.actor.user.id,
        })
      : null;
    const ancestors = await folderAncestorRecordsForPage(input.page);
    return permissionsService.resolve(ctx, {
      workspaceId: input.page.workspaceId,
      userId: input.actor.user?.id ?? "",
      scope: "page",
      targetId: input.page.id,
      memberRole: member?.role ?? null,
      instanceRole: input.actor.user?.role,
      folderPath: ancestors.map((ancestor) => ancestor.id),
    });
  });
}

export async function resolveFolderActorPermission(input: {
  actor: RequestActor;
  folder: FolderRecord;
}): Promise<PermissionLevel> {
  if (
    input.actor.workspaceId &&
    input.actor.workspaceId !== input.folder.workspaceId
  ) {
    return "none";
  }
  return withDb(input.actor, async (ctx) => {
    const member = input.actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId: input.folder.workspaceId,
          userId: input.actor.user.id,
        })
      : null;
    const ancestors = await folderAncestorRecordsForFolder(input.folder);
    return permissionsService.resolve(ctx, {
      workspaceId: input.folder.workspaceId,
      userId: input.actor.user?.id ?? "",
      scope: "folder",
      targetId: input.folder.id,
      memberRole: member?.role ?? null,
      instanceRole: input.actor.user?.role,
      folderPath: ancestors
        .filter((ancestor) => ancestor.id !== input.folder.id)
        .map((ancestor) => ancestor.id),
    });
  });
}

export async function resolveWorkspaceActorPermission(
  actor: RequestActor,
  workspaceId: string,
): Promise<PermissionLevel> {
  if (actor.workspaceId && actor.workspaceId !== workspaceId) return "none";
  return withDb(actor, async (ctx) => {
    const member = actor.user
      ? await workspacesService.getMember(ctx, {
          workspaceId,
          userId: actor.user.id,
        })
      : null;
    return permissionsService.resolve(ctx, {
      workspaceId,
      userId: actor.user?.id ?? "",
      scope: "workspace",
      targetId: workspaceId,
      memberRole: member?.role ?? null,
      instanceRole: actor.user?.role,
    });
  });
}

export async function assertWorkspaceActorPermission(input: {
  actor: RequestActor;
  workspaceId: string;
  required: PermissionLevel;
}): Promise<void> {
  const actual = await resolveWorkspaceActorPermission(
    input.actor,
    input.workspaceId,
  );
  permissionsService.assertLevel({ actual, required: input.required });
}

async function folderForPage(page: PageRecord): Promise<FolderRecord | null> {
  if (!page.folderPath) return null;
  return withDb(null, async (ctx) => {
    const allFolders = await foldersService.listAll(ctx, {
      workspaceId: page.workspaceId,
    });
    return (
      allFolders.find((candidate) => candidate.path === page.folderPath) ?? null
    );
  });
}

async function publicationAncestorsForFolder(
  folder: FolderRecord,
): Promise<FolderRecord[]> {
  return (await folderAncestorRecordsForFolder(folder)).reverse();
}

export async function resolvePublicationForPage(
  page: PageRecord,
): Promise<PublicationRecord | null> {
  return withDb(null, async (ctx) => {
    const direct = await publicationsService.findForResource(ctx, {
      workspaceId: page.workspaceId,
      resourceType: "page",
      resourceId: page.id,
    });
    if (direct) return direct;
    const folder = await folderForPage(page);
    if (!folder) return null;
    for (const candidate of await publicationAncestorsForFolder(folder)) {
      const publication = await publicationsService.findForResource(ctx, {
        workspaceId: folder.workspaceId,
        resourceType: "folder",
        resourceId: candidate.id,
      });
      if (publication) return publication;
    }
    return null;
  });
}

async function resolvePublicationForFolder(
  folder: FolderRecord,
): Promise<PublicationRecord | null> {
  return withDb(null, async (ctx) => {
    for (const candidate of await publicationAncestorsForFolder(folder)) {
      const publication = await publicationsService.findForResource(ctx, {
        workspaceId: folder.workspaceId,
        resourceType: "folder",
        resourceId: candidate.id,
      });
      if (publication) return publication;
    }
    return null;
  });
}

async function verifyPublicationAccess(input: {
  cookies: AstroCookies;
  url: URL;
  publication: PublicationRecord | null;
  password?: string | null;
}): Promise<PublicationRecord | null> {
  if (!input.publication) return null;
  const passwordCookie =
    input.cookies.get(publicationPasswordCookieName(input.publication.id))
      ?.value ?? null;
  const passwordVerified =
    Boolean(input.publication.passwordHash) &&
    passwordCookie ===
      (await publicationPasswordCookieValue(input.publication));
  if (input.publication.passwordHash && !passwordVerified && !input.password) {
    throw new AppError(
      "PUBLICATION_PASSWORD_REQUIRED",
      "This publication requires a password.",
      401,
      {
        publication_id: input.publication.id,
        permission: input.publication.permission,
        resource_type: input.publication.resourceType,
        resource_id: input.publication.resourceId,
      },
    );
  }
  if (passwordVerified) return input.publication;
  if (input.password) {
    const ok = await withDb(null, (ctx) =>
      publicationsService.verifyPassword(ctx, {
        publicationId: input.publication!.id,
        password: input.password!,
      }),
    );
    if (!ok) {
      throw new AppError(
        "PUBLICATION_PASSWORD_INVALID",
        "Password is incorrect.",
        401,
        { publication_id: input.publication.id },
      );
    }
    return input.publication;
  }
  return input.publication;
}

export async function resolvePageAccess(input: {
  cookies: AstroCookies;
  request?: Request;
  url: URL;
  page: PageRecord;
  required: PermissionLevel;
  password?: string | null;
  guestName?: string | null;
}): Promise<PageAccess> {
  assertApiWorkspaceId({ url: input.url, workspaceId: input.page.workspaceId });
  const actor = await getApiRequestActor(input.cookies, input.request);

  const memberPermission = await resolveActorPermission({
    actor,
    page: input.page,
  });
  if (hasPermission(memberPermission, input.required)) {
    return {
      actor,
      permission: memberPermission,
      publicationId: null,
      publication: null,
      guestNameRequired: false,
    };
  }

  const publication = await verifyPublicationAccess({
    cookies: input.cookies,
    url: input.url,
    publication: await resolvePublicationForPage(input.page),
    password: input.password,
  });
  const permission = publication
    ? permissionForPublication(publication.permission)
    : memberPermission;
  permissionsService.assertLevel({
    actual: permission,
    required: input.required,
  });

  const guestNameRequired =
    !actor.user && Boolean(publication) && hasPermission(permission, "comment");
  if (
    guestNameRequired &&
    input.required !== "read" &&
    !input.guestName?.trim()
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Guest display name is required.",
      400,
    );
  }

  return {
    actor,
    permission,
    publicationId: publication?.id ?? null,
    publication,
    guestNameRequired,
  };
}

export async function resolveFolderAccess(input: {
  cookies: AstroCookies;
  request?: Request;
  url: URL;
  folder: FolderRecord;
  required: PermissionLevel;
  password?: string | null;
}): Promise<PageAccess> {
  assertApiWorkspaceId({
    url: input.url,
    workspaceId: input.folder.workspaceId,
  });
  const actor = await getApiRequestActor(input.cookies, input.request);
  const memberPermission = await resolveFolderActorPermission({
    actor,
    folder: input.folder,
  });
  if (hasPermission(memberPermission, input.required)) {
    return {
      actor,
      permission: memberPermission,
      publicationId: null,
      publication: null,
      guestNameRequired: false,
    };
  }
  const publication = await verifyPublicationAccess({
    cookies: input.cookies,
    url: input.url,
    publication: await resolvePublicationForFolder(input.folder),
    password: input.password,
  });
  const permission = publication
    ? permissionForPublication(publication.permission)
    : memberPermission;
  permissionsService.assertLevel({
    actual: permission,
    required: input.required,
  });
  return {
    actor,
    permission,
    publicationId: publication?.id ?? null,
    publication,
    guestNameRequired: false,
  };
}

// ---------------------------------------------------------------------------
// Resource-access admin helpers (per-resource permission grants).

type ResourceAccessScope = "folder" | "page";
type AccessResource =
  | { scope: "folder"; folder: FolderRecord }
  | { scope: "page"; page: PageRecord };

const memberAccessLevels = ["none", "read", "comment", "write"] as const;

function resourceWorkspaceId(resource: AccessResource) {
  return resource.scope === "folder"
    ? resource.folder.workspaceId
    : resource.page.workspaceId;
}

function resourceTargetId(resource: AccessResource) {
  return resource.scope === "folder" ? resource.folder.id : resource.page.id;
}

async function resourcePermission(
  actor: RequestActor,
  resource: AccessResource,
) {
  return resource.scope === "folder"
    ? resolveFolderActorPermission({ actor, folder: resource.folder })
    : resolveActorPermission({ actor, page: resource.page });
}

function parseMemberAccessLevel(value: unknown): PermissionLevel {
  if (
    permissionLevels.includes(value as PermissionLevel) &&
    memberAccessLevels.includes(value as (typeof memberAccessLevels)[number])
  ) {
    return value as PermissionLevel;
  }
  throw new AppError(
    "VALIDATION_ERROR",
    "Access level must be none, read, comment, or write.",
    400,
  );
}

async function assertMemberSubject(workspaceId: string, subjectId: string) {
  const subject = await withDb(null, (ctx) =>
    usersService.getById(ctx, subjectId),
  );
  if (!subject) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose a workspace member for resource access.",
      400,
    );
  }
  const member = await withDb(null, (ctx) =>
    workspacesService.getMember(ctx, { workspaceId, userId: subject.id }),
  );
  if (!member) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose a workspace member for resource access.",
      400,
    );
  }
  return toLegacyUser(subject);
}

async function serializeGrant(grant: PermissionRecord) {
  const user = await withDb(null, (ctx) =>
    usersService.getById(ctx, grant.subjectId),
  );
  return {
    id: grant.id,
    subject_id: grant.subjectId,
    scope: grant.scope,
    target_id: grant.targetId,
    level: grant.level,
    created_at: grant.createdAt,
    updated_at: grant.updatedAt,
    user: user ? toLegacyUser(user) : null,
  };
}

export async function assertResourceAccessAdmin(input: {
  cookies: AstroCookies;
  request: Request;
  resource: AccessResource;
}) {
  assertApiWorkspaceId({
    url: new URL(input.request.url),
    workspaceId: resourceWorkspaceId(input.resource),
  });
  const actor = await getApiRequestActor(input.cookies, input.request);
  const actual = await resourcePermission(actor, input.resource);
  permissionsService.assertLevel({ actual, required: "admin" });
  return { actor, permission: actual };
}

export async function listResourceAccess(
  resource: AccessResource,
  actor: RequestActor | null = null,
) {
  const workspaceId = resourceWorkspaceId(resource);
  const scope: ResourceAccessScope = resource.scope;
  const targetId = resourceTargetId(resource);
  return withDb(actor, async (ctx) => {
    const members = await workspacesService.listMembers(ctx, { workspaceId });
    const membersWithUser = await Promise.all(
      members.map(async (member) => {
        const user = await usersService.getById(ctx, member.userId);
        return {
          id: member.id,
          user_id: member.userId,
          role: member.role,
          user: user ? toLegacyUser(user) : null,
        };
      }),
    );
    const grantsAll = await permissionsService.listGrants(ctx, {
      workspaceId,
      targetId,
    });
    // listGrants doesn't filter by scope — do it in-process. Per-target
    // grant counts are small (single-digit typically), so the filter is
    // cheap.
    const grants = grantsAll.filter((grant) => grant.scope === scope);
    const serialized = await Promise.all(grants.map(serializeGrant));
    return {
      members: membersWithUser,
      grants: serialized,
    };
  });
}

export async function setResourceAccess(input: {
  cookies: AstroCookies;
  request: Request;
  resource: AccessResource;
  body: unknown;
}) {
  const { actor } = await assertResourceAccessAdmin(input);
  const body = input.body as Record<string, unknown>;
  const workspaceId = resourceWorkspaceId(input.resource);
  const subject = await assertMemberSubject(
    workspaceId,
    String(body.subject_id ?? ""),
  );
  const level = parseMemberAccessLevel(body.level);

  if (actor.user?.id === subject.id) {
    throw new AppError(
      "VALIDATION_ERROR",
      "You cannot change your own access from this dialog.",
      400,
    );
  }

  const grant = await withDb(actor, (ctx) =>
    permissionsService.setGrant(ctx, {
      workspaceId,
      subjectId: subject.id,
      scope: input.resource.scope,
      targetId: resourceTargetId(input.resource),
      level,
    }),
  );
  await withDb(actor, (ctx) =>
    audit.record(ctx, {
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "permission.resource_access_set",
      targetType: input.resource.scope,
      targetId: grant.targetId,
      metadata: { subject_id: grant.subjectId, level: grant.level },
    }),
  );
  return serializeGrant(grant);
}

export async function deleteResourceAccess(input: {
  cookies: AstroCookies;
  request: Request;
  resource: AccessResource;
  grantId: string;
}) {
  const { actor } = await assertResourceAccessAdmin(input);
  const workspaceId = resourceWorkspaceId(input.resource);
  const scope = input.resource.scope;
  const targetId = resourceTargetId(input.resource);
  const grantsAll = await withDb(actor, (ctx) =>
    permissionsService.listGrants(ctx, {
      workspaceId,
      targetId,
    }),
  );
  const grants = grantsAll.filter((candidate) => candidate.scope === scope);
  const grant = grants.find((candidate) => candidate.id === input.grantId);
  if (!grant) {
    throw new AppError(
      "PERMISSION_DENIED",
      "Access rule was not found for this resource.",
      404,
    );
  }

  await withDb(actor, (ctx) =>
    permissionsService.deleteGrant(ctx, {
      workspaceId,
      subjectId: grant.subjectId,
      scope: grant.scope,
      targetId: grant.targetId,
    }),
  );
  await withDb(actor, (ctx) =>
    audit.record(ctx, {
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "permission.resource_access_deleted",
      targetType: scope,
      targetId,
      metadata: { subject_id: grant.subjectId, grant_id: grant.id },
    }),
  );
  return { id: grant.id };
}
