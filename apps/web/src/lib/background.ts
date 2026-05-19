// Background-task scheduling for Cloudflare Workers + Node self-host.
//
// On Cloudflare, post-response work (search reindex, audit-log writes,
// cache fill) must be registered via `ctx.waitUntil(...)` so the
// runtime doesn't tear the isolate down before the work completes.
//
// Cloudflare Workers serve MULTIPLE concurrent requests per isolate.
// The earlier version of this module wrote `ctx.waitUntil` to a
// module-level global on every request, which meant request B's
// `setCloudflareWaitUntil` call overwrote request A's slot — and
// background tasks scheduled by A after that point would either land
// on B's ctx (still alive) or, if B had already responded, on a
// torn-down ctx that silently drops them. (Audit cycle 5 finding.)
//
// We now thread the per-request waitUntil through `AsyncLocalStorage`
// so every request has its own isolated waitUntil. The module-level
// fallback remains for: (1) cron handlers that set it once and never
// race, (2) test environments that don't run inside `als.run`, and
// (3) the dynamic `cloudflare:workers` import for the rare case where
// the worker entry didn't wire up the waitUntil eagerly.

import { AsyncLocalStorage } from "node:async_hooks";

type WaitUntil = (promise: Promise<unknown>) => void;
type CloudflareWorkersModule = { waitUntil?: WaitUntil };

const requestScopedWaitUntil = new AsyncLocalStorage<WaitUntil>();
let resolvedWaitUntil: WaitUntil | null = null;
let waitUntilImport: Promise<WaitUntil | null> | null = null;
const pendingTasks = new Set<Promise<unknown>>();

/**
 * Eager hook for the request entry. Pass the runtime's ctx.waitUntil.
 * Prefer `runWithWaitUntil()` over this — the global slot doesn't
 * survive concurrent requests on a single isolate. The cron handler in
 * `worker.ts` is the only legitimate caller because cron invocations
 * don't overlap.
 */
export function setCloudflareWaitUntil(waitUntil: WaitUntil | null) {
  resolvedWaitUntil = waitUntil;
}

/**
 * Run `handler` inside an AsyncLocalStorage scope that exposes
 * `waitUntil` to any `scheduleBackgroundTask()` call made during the
 * scope. Use this from the Worker `fetch()` entry to register tasks
 * against the correct request's ctx.
 */
export function runWithWaitUntil<T>(waitUntil: WaitUntil, handler: () => T): T {
  return requestScopedWaitUntil.run(waitUntil, handler);
}

export function scheduleBackgroundTask(
  name: string,
  task: () => Promise<unknown> | unknown,
) {
  const promise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "vpg.background.failed",
          task: name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  pendingTasks.add(promise);
  void promise.finally(() => pendingTasks.delete(promise));

  // Preferred path — the per-request scoped waitUntil. AsyncLocalStorage
  // guarantees we read the value set by THIS request, not whatever the
  // most recent concurrent request happened to write.
  const scoped = requestScopedWaitUntil.getStore();
  if (scoped) {
    scoped(promise);
    return;
  }

  // Cron + tests + same-isolate hot paths that didn't go through
  // runWithWaitUntil — fall back to the module-level slot.
  if (resolvedWaitUntil) {
    resolvedWaitUntil(promise);
    return;
  }

  void cloudflareWaitUntil().then((waitUntil) => {
    if (waitUntil) waitUntil(promise);
  });
}

async function cloudflareWaitUntil(): Promise<WaitUntil | null> {
  if (!waitUntilImport) {
    waitUntilImport = (async () => {
      const isCloudflareRuntime = process.env.VPG_RUNTIME === "cloudflare";
      if (!isCloudflareRuntime) return null;
      try {
        const specifier = "cloudflare:workers";
        const module = (await import(
          /* @vite-ignore */ specifier
        )) as CloudflareWorkersModule;
        return typeof module.waitUntil === "function" ? module.waitUntil : null;
      } catch {
        return null;
      }
    })();
  }
  return waitUntilImport;
}
