// PublicationRepo — public/link/password-protected resource sharing.
//
// One publication record per (workspaceId, resourceType, resourceId).
// Re-publishing the same resource updates the existing record; revoking
// sets revokedAt rather than deleting (audit trail). Passwords are
// stored as argon2id hashes; the verify path is async because it must
// be constant-time in expensive crypto.

import type {
  PublicationPermission,
  PublicationRecord,
  PublicationResourceType,
  UpsertPublicationInput,
  UpdatePublicationInput,
} from "@vegastack/pages-core";

export type {
  PublicationPermission,
  PublicationRecord,
  PublicationResourceType,
  UpsertPublicationInput,
  UpdatePublicationInput,
};

export type PublicationRepo = {
  get(publicationId: string): Promise<PublicationRecord | null>;
  // Returns the active publication for a (workspace, resourceType, resourceId)
  // tuple, or null if none / revoked.
  findForResource(input: {
    workspaceId: string;
    resourceType: PublicationResourceType;
    resourceId: string;
  }): Promise<PublicationRecord | null>;
  // Lists all non-revoked publications scoped to a workspace.
  listForWorkspace(workspaceId: string): Promise<PublicationRecord[]>;
  // Like listForWorkspace but only those that match a resource and remain
  // usable (not revoked, not expired). Used by access checks on every page
  // load — keep cheap.
  listUsableForResource(input: {
    workspaceId: string;
    resourceType: PublicationResourceType;
    resourceId: string;
  }): Promise<PublicationRecord[]>;

  upsert(input: UpsertPublicationInput): Promise<PublicationRecord>;
  update(
    publicationId: string,
    input: UpdatePublicationInput,
  ): Promise<PublicationRecord>;
  // Constant-time password check; service-layer wraps with rate limiting.
  verifyPassword(input: {
    publicationId: string;
    password: string;
  }): Promise<boolean>;
  // Sets revokedAt; record remains for audit.
  revoke(publicationId: string): Promise<PublicationRecord>;
};
