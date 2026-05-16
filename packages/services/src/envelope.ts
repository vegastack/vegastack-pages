// Mutation envelope builder + JSON Response helper.
//
// Every nav-affecting POST/PUT/PATCH/DELETE endpoint that returns JSON
// should call jsonWithEnvelope() so the envelope is part of the
// response body under the "envelope" key. Clients (browser shell,
// MCP, CLI) read it to invalidate caches without polling.

import type { MutationEnvelope } from "./context.ts";

export type EnvelopeInput = {
  treeVersion: string;
  contentHash?: string | null;
  // Defaults to false. Set true when the sidebar tree shape changes
  // (create/rename/move/delete page or folder; permission grant/revoke
  // that adds or removes a visible item; favorite toggle when the
  // sidebar shows favorites).
  navigationInvalidated?: boolean;
  changedResources: string[];
};

export function buildEnvelope(input: EnvelopeInput): MutationEnvelope {
  const envelope: MutationEnvelope = {
    tree_version: input.treeVersion,
    navigation_invalidated: input.navigationInvalidated ?? false,
    changed_resources: [...new Set(input.changedResources)],
  };
  if (input.contentHash) envelope.content_hash = input.contentHash;
  return envelope;
}

// Build the JSON response and merge in the envelope in one call.
export function jsonWithEnvelope(
  body: Record<string, unknown>,
  envelope: MutationEnvelope,
  init?: ResponseInit,
): Response {
  return Response.json({ ...body, envelope }, init);
}
