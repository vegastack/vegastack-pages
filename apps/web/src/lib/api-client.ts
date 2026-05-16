// Request dispatcher used by the edge Worker (and Node self-host) to call
// the backend service surface (/api/* and /mcp).
//
// On Cloudflare:
//   - Edge Worker holds the API service binding (env.API).
//   - Edge intercepts /api/* and /mcp in middleware and calls apiCall().
//   - apiCall() forwards via env.API.fetch(req) — Service Binding RPC.
//   - Backend Worker has its own fetch() that runs Astro API routes too,
//     so the same Request object lands on the same handler chain.
//
// On Node (self-host or local dev):
//   - There is no service binding. apiCall() dynamically imports the
//     in-process backend module and calls its fetch() directly.
//   - Same code, same bytes, no network hop.
//
// Centralizing this in one function means the rest of the codebase never
// has to ask "am I on Cloudflare or Node?" when making backend calls.

import { detectTarget, type RuntimeTarget } from "./runtime/target";

export type ApiCallEnv = {
  API?: { fetch: (req: Request) => Promise<Response> };
  // The full Env type is intentionally not imported here to keep this
  // module dependency-light. Concrete Env types live in apps/web/src/env.ts
  // (or whichever adapter shim is configured).
  [key: string]: unknown;
};

let nodeBackendImport: Promise<{
  default: {
    fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>;
  };
}> | null = null;

function getNodeBackend() {
  // Lazy import so Cloudflare builds don't pull this module into the edge
  // bundle. The path resolves to apps/web/src/backend/index.ts which is the
  // in-process entry point built specifically for Node self-host.
  nodeBackendImport ??= import(/* @vite-ignore */ "../backend/index");
  return nodeBackendImport;
}

export async function apiCall(
  req: Request,
  env: ApiCallEnv,
  ctx?: {
    waitUntil?: (p: Promise<unknown>) => void;
    passThroughOnException?: () => void;
  },
): Promise<Response> {
  const target: RuntimeTarget = detectTarget(
    env as Parameters<typeof detectTarget>[0],
  );

  if (target === "cloudflare-edge") {
    // Service Binding RPC. Backend Worker handles the request close to D1
    // (Smart Placement) and returns the Response in-process.
    return env.API!.fetch(req);
  }

  // Node self-host OR cloudflare-api role (when the backend Worker reaches
  // its own /api/* internally — rare but valid). In both cases there is no
  // intermediate hop; call the handler directly.
  const backend = await getNodeBackend();
  return backend.default.fetch(req, env, ctx ?? { waitUntil: () => undefined });
}
