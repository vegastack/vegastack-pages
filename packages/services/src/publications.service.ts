// PublicationsService — application logic for sharing pages/folders
// publicly, by link, or with a password.

import type { ServiceContext, MutationEnvelope } from "./context.ts";
import type {
  PublicationRecord,
  PublicationResourceType,
  UpsertPublicationInput,
  UpdatePublicationInput,
} from "./repo/publication.repo.ts";
import { ServiceError } from "./errors.ts";
import { buildEnvelope } from "./envelope.ts";

export type PublicationResult = {
  data: PublicationRecord;
  envelope: MutationEnvelope;
};

export async function apply(
  ctx: ServiceContext,
  input: UpsertPublicationInput,
): Promise<PublicationResult> {
  const publication = await ctx.repo.publications.upsert(input);
  const treeVersion = await ctx.computeTreeVersion(publication.workspaceId);
  return {
    data: publication,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `publication:${publication.id}`,
        `publication:${publication.resourceType}:${publication.resourceId}`,
      ],
    }),
  };
}

export async function update(
  ctx: ServiceContext,
  input: {
    publicationId: string;
    patch: UpdatePublicationInput;
  },
): Promise<PublicationResult> {
  const existing = await ctx.repo.publications.get(input.publicationId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Publication was not found.");
  }
  const updated = await ctx.repo.publications.update(
    input.publicationId,
    input.patch,
  );
  const treeVersion = await ctx.computeTreeVersion(updated.workspaceId);
  return {
    data: updated,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `publication:${updated.id}`,
        `publication:${updated.resourceType}:${updated.resourceId}`,
      ],
    }),
  };
}

export async function revoke(
  ctx: ServiceContext,
  input: { publicationId: string },
): Promise<PublicationResult> {
  const existing = await ctx.repo.publications.get(input.publicationId);
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Publication was not found.");
  }
  const revoked = await ctx.repo.publications.revoke(input.publicationId);
  const treeVersion = await ctx.computeTreeVersion(revoked.workspaceId);
  return {
    data: revoked,
    envelope: buildEnvelope({
      treeVersion,
      navigationInvalidated: false,
      changedResources: [
        `publication:${revoked.id}`,
        `publication:${revoked.resourceType}:${revoked.resourceId}`,
      ],
    }),
  };
}

export async function get(
  ctx: ServiceContext,
  input: { publicationId: string },
): Promise<PublicationRecord> {
  const publication = await ctx.repo.publications.get(input.publicationId);
  if (!publication) {
    throw new ServiceError("NOT_FOUND", "Publication was not found.");
  }
  return publication;
}

export async function findForResource(
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    resourceType: PublicationResourceType;
    resourceId: string;
  },
): Promise<PublicationRecord | null> {
  return ctx.repo.publications.findForResource(input);
}

export async function listForWorkspace(
  ctx: ServiceContext,
  input: { workspaceId: string },
): Promise<PublicationRecord[]> {
  return ctx.repo.publications.listForWorkspace(input.workspaceId);
}
