import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as rateLimit from "../rate-limit.service.ts";
import type { ServiceContext } from "../context.ts";
import { createTestD1 } from "./test-db.ts";

function makeCtx(): ServiceContext {
  const db = createTestD1();
  return {
    actor: { userId: "", email: null, workspaceId: null },
    db,
    objectStore: {
      get: async () => null,
      put: async () => ({
        key: "x",
        body: "",
        updatedAt: new Date().toISOString(),
      }),
      delete: async () => {},
      list: async () => [],
    },
    repo: undefined as unknown as ServiceContext["repo"],
    async computeTreeVersion() {
      return "nav_test";
    },
    waitUntil() {},
    log() {},
  };
}

describe("rate-limit.service", () => {
  it("allows calls while under the limit", async () => {
    const ctx = makeCtx();
    const input = { key: "under-limit", limit: 5, windowMs: 60_000 };
    const r1 = await rateLimit.check(ctx, input);
    const r2 = await rateLimit.check(ctx, input);
    const r3 = await rateLimit.check(ctx, input);
    expect(r1.ok).toBe(true);
    expect(r1.remaining).toBe(4);
    expect(r2.ok).toBe(true);
    expect(r2.remaining).toBe(3);
    expect(r3.ok).toBe(true);
    expect(r3.remaining).toBe(2);
  });

  it("blocks the call that crosses the limit", async () => {
    const ctx = makeCtx();
    const input = { key: "at-limit", limit: 5, windowMs: 60_000 };
    for (let i = 0; i < 5; i += 1) {
      const result = await rateLimit.check(ctx, input);
      expect(result.ok).toBe(true);
    }
    const blocked = await rateLimit.check(ctx, input);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  describe("window reset", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resets the counter after the window elapses", async () => {
      const ctx = makeCtx();
      const input = { key: "window-reset", limit: 2, windowMs: 1_000 };

      const first = await rateLimit.check(ctx, input);
      expect(first.ok).toBe(true);
      expect(first.remaining).toBe(1);

      // Advance past the window boundary.
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));

      const afterReset = await rateLimit.check(ctx, input);
      expect(afterReset.ok).toBe(true);
      expect(afterReset.remaining).toBe(1);
      // resetAt should now reflect the new window (current time + 1s).
      expect(afterReset.resetAt).toBe("2026-01-01T00:00:03.000Z");
    });
  });

  it("keeps counters independent per key", async () => {
    const ctx = makeCtx();
    const a = { key: "a", limit: 2, windowMs: 60_000 };
    const b = { key: "b", limit: 2, windowMs: 60_000 };
    const [a1, b1, a2, b2] = await Promise.all([
      rateLimit.check(ctx, a),
      rateLimit.check(ctx, b),
      rateLimit.check(ctx, a),
      rateLimit.check(ctx, b),
    ]);
    expect(a1.ok).toBe(true);
    expect(b1.ok).toBe(true);
    expect(a2.ok).toBe(true);
    expect(b2.ok).toBe(true);
    // Each key independently consumed 2 tokens; a 3rd a-call must block,
    // and the b-bucket must still be exhausted on its own 3rd call.
    const a3 = await rateLimit.check(ctx, a);
    const b3 = await rateLimit.check(ctx, b);
    expect(a3.ok).toBe(false);
    expect(b3.ok).toBe(false);
  });

  it("requires a D1 binding", async () => {
    const ctx = makeCtx();
    ctx.db = undefined;
    await expect(
      rateLimit.check(ctx, { key: "x", limit: 1, windowMs: 1_000 }),
    ).rejects.toThrow(/ServiceContext\.db is required/);
  });
});
