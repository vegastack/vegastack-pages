// Minimal D1 type aliases.
//
// We intentionally don't depend on @cloudflare/workers-types in the
// services package — the surface we actually use is tiny (prepare /
// bind / first / all / run / exec / batch). Mirroring it here keeps the
// services package portable: the same shape is satisfied by the real
// Cloudflare D1 binding in production and by the better-sqlite3-backed
// adapter in apps/web/src/adapters/node for local dev + tests.

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] } | T[]>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
}

// Normalise the polymorphic `all()` return shape. Real D1 returns
// `{ results: T[] }`; the node-sqlite adapter returns a bare `T[]`.
export function d1AllRows<T>(result: { results?: T[] } | T[]): T[] {
  if (Array.isArray(result)) return result;
  return result.results ?? [];
}
