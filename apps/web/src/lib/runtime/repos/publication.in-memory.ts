// In-memory PublicationRepo adapter wrapping the existing
// publicationService from packages/core.

import type {
  PublicationRepo,
  PublicationRecord,
  PublicationResourceType,
  UpsertPublicationInput,
  UpdatePublicationInput,
} from "@vegastack/pages-services";
import { publicationService } from "../../runtime";

export function createInMemoryPublicationRepo(): PublicationRepo {
  return {
    async get(publicationId: string): Promise<PublicationRecord | null> {
      return publicationService.get(publicationId);
    },
    async findForResource(input: {
      workspaceId: string;
      resourceType: PublicationResourceType;
      resourceId: string;
    }): Promise<PublicationRecord | null> {
      // findForResource doesn't take workspaceId in the legacy service —
      // we filter post-hoc to enforce the workspaceId constraint that
      // the repo interface promises.
      const publication = publicationService.findForResource(
        input.resourceType,
        input.resourceId,
      );
      if (!publication) return null;
      if (publication.workspaceId !== input.workspaceId) return null;
      return publication;
    },
    async listForWorkspace(workspaceId: string): Promise<PublicationRecord[]> {
      return publicationService.listForWorkspace(workspaceId);
    },
    async listUsableForResource(input: {
      workspaceId: string;
      resourceType: PublicationResourceType;
      resourceId: string;
    }): Promise<PublicationRecord[]> {
      // Legacy signature is (resourceType, resourceId) with no workspace
      // filter; we enforce the workspaceId boundary post-hoc.
      return publicationService
        .listUsableForResource(input.resourceType, input.resourceId)
        .filter((publication) => publication.workspaceId === input.workspaceId);
    },
    async upsert(input: UpsertPublicationInput): Promise<PublicationRecord> {
      return publicationService.upsert(input);
    },
    async update(
      publicationId: string,
      input: UpdatePublicationInput,
    ): Promise<PublicationRecord> {
      return publicationService.update(publicationId, input);
    },
    async verifyPassword(input: {
      publicationId: string;
      password: string;
    }): Promise<boolean> {
      // Legacy service throws on bad password and returns the record on
      // good. The repo contract is just boolean; convert throw to false.
      try {
        await publicationService.verifyPassword(
          input.publicationId,
          input.password,
        );
        return true;
      } catch {
        return false;
      }
    },
    async revoke(publicationId: string): Promise<PublicationRecord> {
      return publicationService.revoke(publicationId);
    },
  };
}
