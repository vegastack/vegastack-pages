import {
  AppError,
  type FolderRecord,
  hasPermission,
  type PageRecord,
  type PermissionLevel,
  permissionForPublication,
  type PublicationRecord,
  type UserRecord,
} from "@vegastack/pages-core";
import type { AstroCookies } from "astro";
import {
  authService,
  getMcpSession,
  permissionService,
  publicationService,
  touchMcpSession,
  workspaceService,
} from "./runtime";
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

export function getRequestActor(cookies: AstroCookies): RequestActor {
  const sessionId = cookies.get("vpg_session")?.value ?? null;
  const session = sessionId ? authService.getSession(sessionId) : null;
  const sessionUser = session ? workspaceService.getUser(session.userId) : null;
  if (sessionUser) {
    return {
      user: sessionUser,
      sessionId,
      devFallback: false,
      workspaceId: null,
      authMode: "session",
    };
  }

  const devUser = devAutoLoginUser();
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
  const authHeader = request?.headers.get("authorization") ?? "";
  return authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
}

export async function getApiRequestActor(
  cookies: AstroCookies,
  request?: Request,
): Promise<RequestActor> {
  const bearer = bearerToken(request);
  if (bearer) {
    const session = await getMcpSession(bearer);
    const user = session ? workspaceService.getUser(session.userId) : null;
    if (session && user) {
      const userAgent = request?.headers.get("user-agent") ?? null;
      const origin = request?.headers.get("origin") ?? null;
      void touchMcpSession({
        sessionId: session.id,
        userAgent,
        origin,
      }).catch(() => undefined);
      return {
        user,
        sessionId: session.id,
        devFallback: false,
        workspaceId: session.workspaceId,
        authMode: "mcp_session",
      };
    }
    throw new AppError("AUTH_REQUIRED", "Invalid bearer token.", 401);
  }
  return getRequestActor(cookies);
}

export function folderAncestorIdsForPage(page: PageRecord): string[] {
  if (!page.folderPath) return [];
  const folder = workspaceService
    .listFolders(page.workspaceId)
    .find((candidate) => candidate.path === page.folderPath);
  return folder
    ? workspaceService.folderAncestors(folder.id).map((ancestor) => ancestor.id)
    : [];
}

export function folderAncestorIdsForFolder(folder: FolderRecord): string[] {
  return workspaceService
    .folderAncestors(folder.id)
    .map((ancestor) => ancestor.id);
}

export function resolveActorPermission(input: {
  actor: RequestActor;
  page: PageRecord;
}) {
  if (
    input.actor.workspaceId &&
    input.actor.workspaceId !== input.page.workspaceId
  ) {
    return "none";
  }
  const member = input.actor.user
    ? workspaceService.getMember(input.page.workspaceId, input.actor.user.id)
    : null;
  return permissionService.resolve({
    user: input.actor.user,
    member,
    workspaceId: input.page.workspaceId,
    folderAncestorIds: folderAncestorIdsForPage(input.page),
    pageId: input.page.id,
  });
}

export function resolveFolderActorPermission(input: {
  actor: RequestActor;
  folder: FolderRecord;
}) {
  if (
    input.actor.workspaceId &&
    input.actor.workspaceId !== input.folder.workspaceId
  ) {
    return "none";
  }
  const member = input.actor.user
    ? workspaceService.getMember(input.folder.workspaceId, input.actor.user.id)
    : null;
  return permissionService.resolve({
    user: input.actor.user,
    member,
    workspaceId: input.folder.workspaceId,
    folderAncestorIds: folderAncestorIdsForFolder(input.folder),
  });
}

export function resolveWorkspaceActorPermission(
  actor: RequestActor,
  workspaceId: string,
): PermissionLevel {
  if (actor.workspaceId && actor.workspaceId !== workspaceId) return "none";
  const member = actor.user
    ? workspaceService.getMember(workspaceId, actor.user.id)
    : null;
  return permissionService.resolve({
    user: actor.user,
    member,
    workspaceId,
  });
}

export function assertWorkspaceActorPermission(input: {
  actor: RequestActor;
  workspaceId: string;
  required: PermissionLevel;
}) {
  permissionService.assert({
    actual: resolveWorkspaceActorPermission(input.actor, input.workspaceId),
    required: input.required,
  });
}

function folderForPage(page: PageRecord): FolderRecord | null {
  if (!page.folderPath) return null;
  return (
    workspaceService
      .listFolders(page.workspaceId)
      .find((candidate) => candidate.path === page.folderPath) ?? null
  );
}

export function publicationAncestorsForFolder(
  folder: FolderRecord,
): FolderRecord[] {
  return workspaceService.folderAncestors(folder.id).reverse();
}

export function resolvePublicationForPage(
  page: PageRecord,
): PublicationRecord | null {
  const direct = publicationService.findForResource("page", page.id);
  if (direct) return direct;
  const folder = folderForPage(page);
  if (!folder) return null;
  for (const candidate of publicationAncestorsForFolder(folder)) {
    const publication = publicationService.findForResource(
      "folder",
      candidate.id,
    );
    if (publication) return publication;
  }
  return null;
}

export function resolvePublicationForFolder(
  folder: FolderRecord,
): PublicationRecord | null {
  for (const candidate of publicationAncestorsForFolder(folder)) {
    const publication = publicationService.findForResource(
      "folder",
      candidate.id,
    );
    if (publication) return publication;
  }
  return null;
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
  return publicationService.verifyPassword(
    input.publication.id,
    input.password,
    { passwordVerified },
  );
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

  const memberPermission = resolveActorPermission({ actor, page: input.page });
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
    publication: resolvePublicationForPage(input.page),
    password: input.password,
  });
  const permission = publication
    ? permissionForPublication(publication.permission)
    : memberPermission;
  permissionService.assert({ actual: permission, required: input.required });

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
  const memberPermission = resolveFolderActorPermission({
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
    publication: resolvePublicationForFolder(input.folder),
    password: input.password,
  });
  const permission = publication
    ? permissionForPublication(publication.permission)
    : memberPermission;
  permissionService.assert({ actual: permission, required: input.required });
  return {
    actor,
    permission,
    publicationId: publication?.id ?? null,
    publication,
    guestNameRequired: false,
  };
}
