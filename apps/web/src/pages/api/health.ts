// Lightweight liveness probe.
//
// Returns 200 + a tiny JSON body that uptime monitors (Cloudflare Health
// Checks, UptimeRobot, internal probes) can hit cheaply. Does NOT touch
// D1, R2, or any external service — the goal is "is the Worker serving
// HTTP at all", not "are dependencies healthy".
//
// For a deeper readiness probe (D1 connectivity, R2 reachability), build
// a separate `/api/ready` that the deployer can opt into.

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = () => {
  return Response.json(
    {
      ok: true,
      runtime: process.env.VPG_RUNTIME ?? null,
      build: process.env.VPG_BUILD_VERSION ?? null,
      time: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
};
