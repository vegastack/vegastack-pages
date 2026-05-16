// Mutation envelope builder + Response helpers.
//
// Every nav-affecting POST/PUT/PATCH/DELETE endpoint should call
// attachEnvelope() before returning. The envelope is added under the
// "envelope" key in the JSON body so existing top-level fields are
// preserved (backward compatibility — clients that don't know about
// the envelope just ignore it).
//
// Usage from a route handler:
//
//   import { buildEnvelope, attachEnvelope } from "@vegastack/pages-services";
//   ...
//   const updated = await pageService.updateSource({...});
//   return attachEnvelope(
//     Response.json({ page_id: updated.page.id, ... }),
//     buildEnvelope({
//       treeVersion,
//       contentHash: updated.page.contentHash,
//       changedResources: [`page:${updated.page.id}`],
//     }),
//   );

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

// Merges the envelope into an existing JSON Response. The Response body
// is consumed and rewritten. Headers and status are preserved.
//
// Single contract: the envelope is ALWAYS in the JSON body under the
// `envelope` key. Non-JSON or malformed-JSON responses throw rather than
// silently falling back to an x-vpg-envelope header — having two
// contracts means clients must check two places, which leads to bugs.
// If a nav-affecting route needs to return a non-JSON payload (file
// download, etc.), it should return JSON metadata alongside or wrap the
// download in a JSON envelope.
export async function attachEnvelope(
  response: Response,
  envelope: MutationEnvelope,
): Promise<Response> {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(
      `attachEnvelope requires a JSON response (got content-type "${contentType}"). ` +
        "Nav-affecting routes must return application/json so the envelope " +
        "can be merged into the body.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `attachEnvelope could not parse the response JSON body: ${
        (error as Error).message
      }`,
    );
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    (body as Record<string, unknown>).envelope = envelope;
  } else {
    body = { data: body, envelope };
  }
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// One-call helper: build the JSON response and the envelope in a single
// statement. Most route handlers will use this rather than calling
// Response.json() + attachEnvelope() separately.
export function jsonWithEnvelope(
  body: Record<string, unknown>,
  envelope: MutationEnvelope,
  init?: ResponseInit,
): Response {
  return Response.json({ ...body, envelope }, init);
}
