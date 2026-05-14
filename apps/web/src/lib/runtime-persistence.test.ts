import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimeModule = typeof import("./runtime");

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.VPG_ADAPTER;
  delete process.env.VPG_RUNTIME;
  delete process.env.VPG_SQLITE_PATH;
  delete process.env.VPG_STATE_DIR;
  delete process.env.VPG_DB_MIGRATIONS_DIR;
  delete process.env.VPG_D1_MAX_BATCH_STATEMENTS;
  delete process.env.VPG_ALLOW_EPHEMERAL_CONTENT;
  delete process.env.VPG_DEPLOYMENT_MODE;
  delete process.env.VPG_PUBLIC_SIGNUP;
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime D1 persistence", () => {
  it("requires a durable CONTENT binding when Cloudflare D1 is configured", async () => {
    vi.resetModules();
    const runtime = await import("./runtime");
    const bindings = {
      DB: { prepare: () => undefined },
    } as never;

    expect(() =>
      runtime.assertRuntimeStorageBindings({
        bindings,
        nodeRuntime: false,
      }),
    ).toThrow(/CONTENT/);

    process.env.VPG_ALLOW_EPHEMERAL_CONTENT = "true";
    expect(() =>
      runtime.assertRuntimeStorageBindings({
        bindings,
        nodeRuntime: false,
      }),
    ).not.toThrow();
  });

  it("preserves external integration rows across normalized state persists", async () => {
    const { runtime, sqlitePath } = await freshNodeRuntime();
    const user = runtime.workspaceService.createUser({
      id: "usr_persist_identity",
      email: "persist-identity@example.com",
      displayName: "Persist Identity",
    });
    const workspace = runtime.workspaceService.createWorkspace({
      id: "wks_persist_job",
      name: "Persist Job",
      slug: "persist-job",
    });
    await runtime.persistRuntimeState();

    const db = await openSqlite(sqlitePath);
    const now = new Date().toISOString();
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "aid_google_keep",
      user.id,
      "google",
      "google-subject",
      user.email,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO jobs (id, workspace_id, type, status, payload_json, result_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "job_keep",
      workspace.id,
      "object_move",
      "queued",
      "{}",
      null,
      null,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO github_sync_connections (id, workspace_id, installation_id, repo_owner, repo_name, repo_id, branch, root_path, include_assets, enabled, last_status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "ghc_keep",
      workspace.id,
      12345,
      "vegastack",
      "pages-backup",
      67890,
      "main",
      "docs",
      1,
      1,
      "success",
      user.id,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO github_sync_runs (id, connection_id, workspace_id, status, started_at, finished_at, base_commit_sha, head_commit_sha, pages_written, templates_written, assets_written, files_deleted, error_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "ghr_keep",
      "ghc_keep",
      workspace.id,
      "success",
      now,
      now,
      "base",
      "head",
      1,
      2,
      3,
      4,
      null,
    );

    await runtime.persistRuntimeState();

    expect(
      db
        .prepare("SELECT id FROM auth_identities WHERE id = ?")
        .get("aid_google_keep"),
    ).toMatchObject({ id: "aid_google_keep" });
    expect(
      db.prepare("SELECT id FROM jobs WHERE id = ?").get("job_keep"),
    ).toMatchObject({ id: "job_keep" });
    expect(
      db
        .prepare(
          "SELECT id, repo_name as repoName FROM github_sync_connections WHERE id = ?",
        )
        .get("ghc_keep"),
    ).toMatchObject({ id: "ghc_keep", repoName: "pages-backup" });
    expect(
      db
        .prepare(
          "SELECT id, head_commit_sha as headCommitSha FROM github_sync_runs WHERE id = ?",
        )
        .get("ghr_keep"),
    ).toMatchObject({ id: "ghr_keep", headCommitSha: "head" });
    db.close();
  });

  it("rejects normalized D1 batches that exceed the configured statement cap", async () => {
    const { runtime } = await freshNodeRuntime();
    process.env.VPG_D1_MAX_BATCH_STATEMENTS = "1";

    await expect(runtime.persistRuntimeState()).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      details: {
        max_statements: 1,
      },
    });
  });

  it("increments D1 rate limits atomically under concurrent checks", async () => {
    const { runtime } = await freshNodeRuntime();
    const attempts = await Promise.allSettled([
      runtime.checkRateLimit({
        key: "atomic-rate-limit",
        limit: 1,
        windowMs: 60_000,
      }),
      runtime.checkRateLimit({
        key: "atomic-rate-limit",
        limit: 1,
        windowMs: 60_000,
      }),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      attempts.find((attempt) => attempt.status === "rejected"),
    ).toMatchObject({
      reason: {
        code: "RATE_LIMITED",
      },
    });
  });

  it("migrates existing page slug ids and search URLs to 12 hex characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpg-slug-migration-"));
    tempDirs.push(dir);
    const db = await openSqlite(join(dir, "runtime.sqlite"));
    db.exec(
      [
        "CREATE TABLE pages (id TEXT PRIMARY KEY, slug TEXT NOT NULL, slug_id TEXT NOT NULL, deleted_at TEXT)",
        "CREATE TABLE search_documents (page_id TEXT PRIMARY KEY, url TEXT NOT NULL)",
        "INSERT INTO pages (id, slug, slug_id, deleted_at) VALUES ('pg_a8f31c123456000000000000', 'old-title', 'old-title-a8f31c', NULL)",
        "INSERT INTO search_documents (page_id, url) VALUES ('pg_a8f31c123456000000000000', '/p/old-title-a8f31c')",
      ].join(";"),
    );
    db.exec(
      readFileSync(
        join(
          process.cwd(),
          "packages/db/migrations/0010_expand_page_slug_ids.sql",
        ),
        "utf8",
      ),
    );

    expect(
      db
        .prepare("SELECT slug_id as slugId FROM pages WHERE id = ?")
        .get("pg_a8f31c123456000000000000"),
    ).toMatchObject({ slugId: "old-title-a8f31c123456" });
    expect(
      db
        .prepare("SELECT url FROM search_documents WHERE page_id = ?")
        .get("pg_a8f31c123456000000000000"),
    ).toMatchObject({ url: "/p/old-title-a8f31c123456" });
    db.close();
  });

  it("repairs older comment tables that predate guest sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpg-comment-schema-repair-"));
    tempDirs.push(dir);
    const sqlitePath = join(dir, "runtime.sqlite");
    process.env.VPG_ADAPTER = "node";
    process.env.VPG_SQLITE_PATH = sqlitePath;
    process.env.VPG_STATE_DIR = dir;
    process.env.VPG_DB_MIGRATIONS_DIR = join(
      process.cwd(),
      "packages/db/migrations",
    );

    let db = await openSqlite(sqlitePath);
    db.exec(
      [
        "CREATE TABLE comment_threads (id TEXT PRIMARY KEY NOT NULL, page_id TEXT NOT NULL, workspace_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', selected_text TEXT NOT NULL, guest_name TEXT, publication_id TEXT, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        "CREATE TABLE comment_replies (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL, author_type TEXT NOT NULL, author_user_id TEXT, guest_name TEXT, publication_id TEXT, agent_name TEXT, agent_model TEXT, agent_session_id TEXT, created_at TEXT NOT NULL)",
      ].join(";"),
    );
    db.close();

    vi.resetModules();
    const runtime = await import("./runtime");
    await runtime.ensureRuntimeReady();

    db = await openSqlite(sqlitePath);
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('comment_threads') WHERE name = 'guest_session_id'",
        )
        .get(),
    ).toMatchObject({ name: "guest_session_id" });
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('comment_replies') WHERE name = 'guest_session_id'",
        )
        .get(),
    ).toMatchObject({ name: "guest_session_id" });
    db.close();
  });
});

async function freshNodeRuntime(): Promise<{
  runtime: RuntimeModule;
  sqlitePath: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "vpg-runtime-"));
  tempDirs.push(dir);
  process.env.VPG_ADAPTER = "node";
  process.env.VPG_SQLITE_PATH = join(dir, "runtime.sqlite");
  process.env.VPG_STATE_DIR = dir;
  process.env.VPG_DB_MIGRATIONS_DIR = join(
    process.cwd(),
    "packages/db/migrations",
  );
  vi.resetModules();
  const runtime = await import("./runtime");
  await runtime.ensureRuntimeReady();
  return { runtime, sqlitePath: process.env.VPG_SQLITE_PATH };
}

async function openSqlite(path: string): Promise<{
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    run(...values: unknown[]): unknown;
  };
  close(): void;
}> {
  const sqliteSpecifier = "node:sqlite";
  const { DatabaseSync } = (await import(
    /* @vite-ignore */ sqliteSpecifier
  )) as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        get(...values: unknown[]): unknown;
        run(...values: unknown[]): unknown;
      };
      close(): void;
    };
  };
  return new DatabaseSync(path);
}
