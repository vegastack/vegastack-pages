// Test fixture: an in-memory D1 database for service-level tests.
//
// Uses Node 22's built-in `node:sqlite` (DatabaseSync). The schema is
// loaded from the canonical packages/db/migrations/0001_init.sql and
// 0002_oauth_seed.sql so every test runs against the same shape that
// ships to Cloudflare D1.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database, D1PreparedStatement } from "@vegastack/pages-db";

// __dirname equivalent in ESM.
const __dirname = dirname(fileURLToPath(import.meta.url));

// packages/services/src/__tests__/test-db.ts → packages/db/migrations
const MIGRATIONS_DIR = resolve(__dirname, "../../../db/migrations");

// node:sqlite returns native row objects; D1 expects plain JS objects.
// They already are, so we just need to satisfy the type contract.

class TestPreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new TestPreparedStatement(this.db, this.query, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.db.prepare(this.query);
    return (stmt.get(...this.bindArgs()) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const stmt = this.db.prepare(this.query);
    const rows = stmt.all(...this.bindArgs()) as T[];
    return { results: rows };
  }

  async run(): Promise<unknown> {
    const stmt = this.db.prepare(this.query);
    return stmt.run(...this.bindArgs());
  }

  // node:sqlite rejects `null` in positional args but accepts `null` in
  // an array literal; convert undefined → null so callers can pass
  // optional fields uniformly. The cast to SQLInputValue is safe in
  // tests — services pass primitives through .bind().
  private bindArgs(): (string | number | bigint | null | Uint8Array)[] {
    return this.values.map((v) =>
      v === undefined
        ? null
        : (v as string | number | bigint | null | Uint8Array),
    );
  }
}

export class TestD1Database implements D1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new TestPreparedStatement(this.db, query);
  }

  async exec(query: string): Promise<unknown> {
    this.db.exec(query);
    return undefined;
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    if (statements.length === 0) return [];
    this.db.exec("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// Build a fresh in-memory D1 with the canonical schema applied.
// Each test should call this in its setup so tests don't share state.
export function createTestD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
  }
  return new TestD1Database(db);
}
