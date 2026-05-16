// Backend Worker entry point — placeholder during foundation phase.
//
// Today's deployment is single-Worker: every request (Astro pages,
// /api/*, /mcp) is handled by `apps/web/src/worker.ts` (the Astro-
// generated Cloudflare adapter entry). This file exists ONLY to make
// the `apps/web/src/lib/api-client.ts` dispatcher importable — its
// dynamic import target needs to resolve.
//
// `apps/web/src/lib/api-client.ts:apiCall()` would forward to this
// handler in two scenarios:
//   1. Cloudflare two-Worker deploy (edge → backend service binding).
//      The actual backend Worker bundle would replace this file with
//      a real router. NOT shipped in v1.
//   2. Node self-host where `apiCall` is invoked from edge-style code
//      (none exists yet; apiCall has no consumers in v1).
//
// Returning 503 (rather than 501) makes the intent explicit: the
// handler exists but the operation is currently unavailable because
// the Worker split isn't deployed. No production code path reaches
// here in v1; if you see this response in prod it indicates a real
// configuration bug.
//
// Plan: docs/plans/007-instant-workspace-architecture.md §5–6, §F.3.

export type BackendHandler = {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
};

const handler: BackendHandler = {
  async fetch(
    _request: Request,
    _env: unknown,
    _ctx: unknown,
  ): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: {
          code: "BACKEND_NOT_DEPLOYED",
          message:
            "The backend Worker is not deployed yet. /api/* and /mcp routes are served by the unified Worker. See docs/plans/007 §B.",
        },
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-vpg-backend-stub": "true",
        },
      },
    );
  },
};

export default handler;
