// Deep readiness probe. Returns 200 only when the Worker is configured
// AND its critical dependencies are reachable (D1 connect, R2 reachable).
//
// Use this for load-balancer-style readiness checks. Liveness (am I
// alive at all?) lives at /api/health which never touches dependencies.
// Plan 011 §10.

import type { APIRoute } from "astro";
import { getDb, getObjectStore } from "../../lib/runtime";

export const prerender = false;

type CheckResult = { ok: boolean; durationMs: number; error?: string };

async function check(fn: () => Promise<void>): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    await fn();
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const GET: APIRoute = async () => {
  const d1 = await check(async () => {
    const db = await getDb();
    if (!db) throw new Error("D1 binding unavailable.");
    const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error("D1 probe row was not 1.");
  });

  const r2 = await check(async () => {
    const store = await getObjectStore();
    // Cheap probe — list with a tiny prefix; doesn't require a known
    // healthcheck object to exist. R2 / Node-FS facades both implement
    // list().
    await store.list(".healthcheck/");
  });

  const allOk = d1.ok && r2.ok;
  return Response.json(
    {
      ok: allOk,
      time: new Date().toISOString(),
      runtime: process.env.VPG_RUNTIME ?? null,
      build: process.env.VPG_BUILD_VERSION ?? null,
      checks: { d1, r2 },
    },
    {
      status: allOk ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
};
