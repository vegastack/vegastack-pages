// Centralized runtime detection. Same codebase ships to:
//   - Cloudflare managed: edge Worker + backend Worker (service binding)
//   - Node self-host: single Node process with SQLite + filesystem
//
// Every Cloudflare-only optimization (Smart Placement, D1 Sessions API,
// D1 replicas, KV sessions, service-binding split, edge cache) must
// short-circuit to a no-op on Node. Detection happens here, in exactly
// one place, so the rest of the code never branches on runtime.

export type RuntimeTarget = "cloudflare-edge" | "cloudflare-api" | "node";

type EnvLike = {
  // VPG_RUNTIME is the authoritative role discriminator when set
  // ("cloudflare-edge" | "cloudflare-api" | "node"). The wrangler
  // configs for each Worker set it explicitly; the Node adapter sets
  // it from the process env. This avoids inferring the role from a
  // capability (D1 Sessions, service binding) that may be absent in
  // local/miniflare or pre-deploy environments.
  VPG_RUNTIME?: string;
  DB?: { withSession?: (bookmark?: string) => unknown };
  API?: { fetch?: (req: Request) => Promise<Response> };
  // Other bindings intentionally ignored here; this helper only decides
  // runtime *role*, not capability.
};

function isRuntimeTarget(value: unknown): value is RuntimeTarget {
  return (
    value === "cloudflare-edge" ||
    value === "cloudflare-api" ||
    value === "node"
  );
}

export function detectTarget(env: EnvLike | undefined | null): RuntimeTarget {
  // 1. Explicit override wins (wrangler env in production; process env on Node).
  const declared = env?.VPG_RUNTIME;
  if (isRuntimeTarget(declared)) return declared;
  // 2. Fall back to binding-shape inference. Cloudflare Workers always have
  //    a DB binding object (even when D1 Sessions is unavailable in local
  //    miniflare); a service binding distinguishes edge from backend.
  if (env && env.DB) {
    return typeof env.API?.fetch === "function"
      ? "cloudflare-edge"
      : "cloudflare-api";
  }
  return "node";
}

export function isCloudflare(env: EnvLike | undefined | null): boolean {
  const t = detectTarget(env);
  return t === "cloudflare-edge" || t === "cloudflare-api";
}

export function isNode(env: EnvLike | undefined | null): boolean {
  return detectTarget(env) === "node";
}
