import { argon2id, argon2Verify } from "hash-wasm";
import { AppError } from "./errors";
import { createId, idPrefixes } from "./ids";

export type PublicationPermission = "view" | "comment" | "edit";
export type PublicationResourceType = "page" | "folder";

export type PublicationRecord = {
  id: string;
  workspaceId: string;
  resourceType: PublicationResourceType;
  resourceId: string;
  permission: PublicationPermission;
  expiresAt: string | null;
  passwordHash: string | null;
  indexingEnabled: boolean;
  revokedAt: string | null;
  // R2 key of the latest baked HTML for this publication. Written by
  // publishFanOut in packages/services/src/publications.service.ts.
  latestArtifactKey: string | null;
  // Convenience copy of the page's content_hash at publish time.
  latestContentHash: string | null;
  // When the artifact was rebuilt — used in ETag computation.
  latestRenderedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertPublicationInput = {
  id?: string;
  workspaceId: string;
  resourceType: PublicationResourceType;
  resourceId: string;
  permission?: PublicationPermission;
  expiresAt?: string | null;
  password?: string | null;
  indexingEnabled?: boolean;
};

export type UpdatePublicationInput = {
  permission?: PublicationPermission;
  expiresAt?: string | null;
  password?: string | null;
  indexingEnabled?: boolean;
};

const publicationPasswordArgon2 = {
  iterations: 3,
  memorySize: 8192,
  parallelism: 1,
  hashLength: 32,
} as const;

function randomSalt(bytes = 16): Uint8Array {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return value;
}

async function hashPublicationPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomSalt(),
    iterations: publicationPasswordArgon2.iterations,
    memorySize: publicationPasswordArgon2.memorySize,
    parallelism: publicationPasswordArgon2.parallelism,
    hashLength: publicationPasswordArgon2.hashLength,
    outputType: "encoded",
  });
}

async function verifyPublicationPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return argon2Verify({ password, hash: passwordHash });
}

export class PublicationService {
  private readonly publications = new Map<string, PublicationRecord>();

  async upsert(input: UpsertPublicationInput): Promise<PublicationRecord> {
    const now = new Date().toISOString();
    const existing = this.findForResource(
      input.resourceType,
      input.resourceId,
      {
        includeRevoked: true,
      },
    );
    const publication: PublicationRecord = {
      id: existing?.id ?? input.id ?? createId(idPrefixes.publication),
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      permission: input.permission ?? existing?.permission ?? "view",
      expiresAt:
        input.expiresAt === undefined
          ? (existing?.expiresAt ?? null)
          : input.expiresAt,
      passwordHash:
        input.password === undefined
          ? (existing?.passwordHash ?? null)
          : input.password
            ? await hashPublicationPassword(input.password)
            : null,
      indexingEnabled:
        input.indexingEnabled ?? existing?.indexingEnabled ?? false,
      revokedAt: null,
      latestArtifactKey: existing?.latestArtifactKey ?? null,
      latestContentHash: existing?.latestContentHash ?? null,
      latestRenderedAt: existing?.latestRenderedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.publications.set(publication.id, publication);
    return publication;
  }

  private assertUsable(publication: PublicationRecord | null) {
    if (!publication || publication.revokedAt) {
      throw new AppError(
        "PUBLICATION_NOT_FOUND",
        "Publication was not found.",
        404,
      );
    }
    if (
      publication.expiresAt &&
      Date.parse(publication.expiresAt) <= Date.now()
    ) {
      throw new AppError("PERMISSION_DENIED", "Publication has expired.", 403);
    }
    return publication;
  }

  async verifyPassword(
    publicationId: string,
    password?: string | null,
    options: { passwordVerified?: boolean } = {},
  ): Promise<PublicationRecord> {
    const publication = this.assertUsable(
      this.publications.get(publicationId) ?? null,
    );
    if (!publication.passwordHash || options.passwordVerified) {
      return publication;
    }
    if (
      !password ||
      !(await verifyPublicationPassword(publication.passwordHash, password))
    ) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Invalid publication password.",
        403,
      );
    }
    return publication;
  }

  findForResource(
    resourceType: PublicationResourceType,
    resourceId: string,
    options: { includeRevoked?: boolean } = {},
  ): PublicationRecord | null {
    const publication =
      [...this.publications.values()].find(
        (candidate) =>
          candidate.resourceType === resourceType &&
          candidate.resourceId === resourceId,
      ) ?? null;
    if (!publication) return null;
    if (!options.includeRevoked && publication.revokedAt) return null;
    return publication;
  }

  listForWorkspace(workspaceId: string): PublicationRecord[] {
    return [...this.publications.values()]
      .filter(
        (publication) =>
          publication.workspaceId === workspaceId && !publication.revokedAt,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listUsableForResource(
    resourceType: PublicationResourceType,
    resourceId: string,
  ): PublicationRecord[] {
    return [...this.publications.values()]
      .filter(
        (publication) =>
          publication.resourceType === resourceType &&
          publication.resourceId === resourceId &&
          !publication.revokedAt &&
          (!publication.expiresAt ||
            Date.parse(publication.expiresAt) > Date.now()),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(publicationId: string): PublicationRecord | null {
    return this.publications.get(publicationId) ?? null;
  }

  async update(
    publicationId: string,
    input: UpdatePublicationInput,
  ): Promise<PublicationRecord> {
    const publication = this.publications.get(publicationId);
    if (!publication || publication.revokedAt) {
      throw new AppError(
        "PUBLICATION_NOT_FOUND",
        "Publication was not found.",
        404,
      );
    }
    return this.upsert({
      id: publication.id,
      workspaceId: publication.workspaceId,
      resourceType: publication.resourceType,
      resourceId: publication.resourceId,
      permission: input.permission ?? publication.permission,
      expiresAt:
        input.expiresAt === undefined ? publication.expiresAt : input.expiresAt,
      password:
        input.password === undefined
          ? undefined
          : input.password
            ? input.password
            : null,
      indexingEnabled: input.indexingEnabled ?? publication.indexingEnabled,
    });
  }

  revoke(publicationId: string): PublicationRecord {
    const publication = this.publications.get(publicationId);
    if (!publication) {
      throw new AppError(
        "PUBLICATION_NOT_FOUND",
        "Publication was not found.",
        404,
      );
    }
    const now = new Date().toISOString();
    const revoked = { ...publication, revokedAt: now, updatedAt: now };
    this.publications.set(publicationId, revoked);
    return revoked;
  }
}
