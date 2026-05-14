import {
  AppError,
  permissionLevels,
  type FolderRecord,
  type PageRecord,
  type PermissionLevel,
  type PermissionRecord,
} from "@vegastack/pages-core";
import type { AstroCookies } from "astro";
import {
  assertApiWorkspaceId,
  getApiRequestActor,
  resolveActorPermission,
  resolveFolderActorPermission,
  type RequestActor,
} from "./access";
import { auditService, permissionService, workspaceService } from "./runtime";

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

function resourcePermission(actor: RequestActor, resource: AccessResource) {
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

function assertMemberSubject(workspaceId: string, subjectId: string) {
  const subject = workspaceService.getUser(subjectId);
  if (!subject || !workspaceService.getMember(workspaceId, subject.id)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose a workspace member for resource access.",
      400,
    );
  }
  return subject;
}

function serializeGrant(grant: PermissionRecord) {
  return {
    id: grant.id,
    subject_id: grant.subjectId,
    scope: grant.scope,
    target_id: grant.targetId,
    level: grant.level,
    created_at: grant.createdAt,
    updated_at: grant.updatedAt,
    user: workspaceService.getUser(grant.subjectId),
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
  const actual = resourcePermission(actor, input.resource);
  permissionService.assert({ actual, required: "admin" });
  return { actor, permission: actual };
}

export function listResourceAccess(resource: AccessResource) {
  const workspaceId = resourceWorkspaceId(resource);
  const scope: ResourceAccessScope = resource.scope;
  const targetId = resourceTargetId(resource);
  return {
    members: workspaceService.listMembers(workspaceId).map((member) => ({
      id: member.id,
      user_id: member.userId,
      role: member.role,
      user: workspaceService.getUser(member.userId),
    })),
    grants: permissionService
      .listGrants({ workspaceId, scope, targetId })
      .map(serializeGrant),
  };
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
  const subject = assertMemberSubject(
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

  const grant = permissionService.setGrant({
    workspaceId,
    subjectId: subject.id,
    scope: input.resource.scope,
    targetId: resourceTargetId(input.resource),
    level,
  });
  auditService.record({
    workspaceId,
    actorUserId: actor.user?.id ?? null,
    action: "permission.resource_access_set",
    targetType: input.resource.scope,
    targetId: grant.targetId,
    metadata: { subject_id: grant.subjectId, level: grant.level },
  });
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
  const grant = permissionService
    .listGrants({ workspaceId, scope, targetId })
    .find((candidate) => candidate.id === input.grantId);
  if (!grant) {
    throw new AppError(
      "PERMISSION_DENIED",
      "Access rule was not found for this resource.",
      404,
    );
  }

  const deleted = permissionService.deleteGrant(grant.id);
  auditService.record({
    workspaceId,
    actorUserId: actor.user?.id ?? null,
    action: "permission.resource_access_deleted",
    targetType: deleted.scope,
    targetId: deleted.targetId,
    metadata: { subject_id: deleted.subjectId, level: deleted.level },
  });
  return serializeGrant(deleted);
}
