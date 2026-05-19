import { describe, expect, it } from "vitest";
import {
  runWithWaitUntil,
  scheduleBackgroundTask,
  setCloudflareWaitUntil,
} from "./background";

describe("scheduleBackgroundTask + runWithWaitUntil", () => {
  it("registers tasks against the per-request scoped waitUntil, not a global", async () => {
    // Audit cycle 5 regression: before AsyncLocalStorage, two concurrent
    // requests on the same Cloudflare isolate would clobber each other's
    // waitUntil via the module-level slot. A task scheduled by request A
    // could end up registered against request B's ctx.waitUntil (or, if
    // B had already responded, a torn-down ctx that silently drops it).
    //
    // This test interleaves two `runWithWaitUntil` scopes and asserts
    // that each task lands in its originating scope's waitUntil bucket.
    setCloudflareWaitUntil(null);
    const captureA: Promise<unknown>[] = [];
    const captureB: Promise<unknown>[] = [];

    await Promise.all([
      runWithWaitUntil(
        (promise) => captureA.push(promise),
        async () => {
          // Schedule a task synchronously inside scope A.
          scheduleBackgroundTask("a-sync", async () => "a-sync");
          // Yield to the event loop so scope B can start.
          await new Promise((resolve) => setTimeout(resolve, 0));
          // After yielding back, A's task should still land in A.
          scheduleBackgroundTask("a-async", async () => "a-async");
        },
      ),
      runWithWaitUntil(
        (promise) => captureB.push(promise),
        async () => {
          scheduleBackgroundTask("b-sync", async () => "b-sync");
          await new Promise((resolve) => setTimeout(resolve, 0));
          scheduleBackgroundTask("b-async", async () => "b-async");
        },
      ),
    ]);

    // Each scope must have captured exactly its own two tasks. If
    // AsyncLocalStorage isolation is broken, A and B share state and
    // either side could be over- or under-counted.
    expect(captureA.length).toBe(2);
    expect(captureB.length).toBe(2);
    await Promise.all([...captureA, ...captureB]);
  });

  it("falls back to setCloudflareWaitUntil when no AsyncLocalStorage scope is active", async () => {
    // Cron handlers + tests can call setCloudflareWaitUntil directly
    // and skip the per-request scope; the fallback must keep working.
    const captured: Promise<unknown>[] = [];
    setCloudflareWaitUntil((promise) => captured.push(promise));
    scheduleBackgroundTask("cron-task", async () => "done");
    expect(captured.length).toBe(1);
    await captured[0];
    setCloudflareWaitUntil(null);
  });

  it("prefers per-request scope over the module-level fallback", async () => {
    // If a cron + a request fire on the same isolate at the same time,
    // the request must NOT pull from the cron's fallback slot. Scope wins.
    const captureGlobal: Promise<unknown>[] = [];
    const captureScoped: Promise<unknown>[] = [];
    setCloudflareWaitUntil((promise) => captureGlobal.push(promise));
    await runWithWaitUntil(
      (promise) => captureScoped.push(promise),
      async () => {
        scheduleBackgroundTask("scoped-only", async () => "scoped");
      },
    );
    expect(captureScoped.length).toBe(1);
    expect(captureGlobal.length).toBe(0);
    setCloudflareWaitUntil(null);
    await captureScoped[0];
  });
});
