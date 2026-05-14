import { AppError } from "./errors";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
};

export class RateLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; resetAtMs: number }
  >();

  check(input: {
    key: string;
    limit: number;
    windowMs: number;
  }): RateLimitResult {
    const now = Date.now();
    const existing = this.buckets.get(input.key);
    const bucket =
      !existing || existing.resetAtMs <= now
        ? { count: 0, resetAtMs: now + input.windowMs }
        : existing;
    bucket.count += 1;
    this.buckets.set(input.key, bucket);

    const remaining = Math.max(0, input.limit - bucket.count);
    if (bucket.count > input.limit) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        {
          reset_at: new Date(bucket.resetAtMs).toISOString(),
        },
      );
    }
    return {
      allowed: true,
      remaining,
      resetAt: new Date(bucket.resetAtMs).toISOString(),
    };
  }
}
