import { NodeSqliteD1Database, type D1Database } from "./node-sqlite-d1";

export async function nodeStateFilePath(): Promise<string> {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const dir = process.env.VPG_STATE_DIR ?? ".vegastack-pages/state";
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "runtime-state.json");
}

export async function readNodeStateFile(): Promise<string | null> {
  const fsSpecifier = "node:fs/promises";
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const stateFile = await nodeStateFilePath();
  try {
    return (await fs.readFile(stateFile, "utf8")) as string;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeNodeStateFile(contents: string): Promise<void> {
  const fsSpecifier = "node:fs/promises";
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const stateFile = await nodeStateFilePath();
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(tmpFile, contents, "utf8");
  await fs.rename(tmpFile, stateFile);
}

export async function nodeSqliteFilePath(): Promise<string> {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const explicit = process.env.VPG_SQLITE_PATH;
  if (explicit) {
    // ":memory:" is a node:sqlite sentinel — no filesystem path to
    // mkdir for. Used by the vitest config to give each worker
    // process its own in-memory database.
    if (explicit === ":memory:") return explicit;
    await fs.mkdir(path.dirname(explicit), { recursive: true });
    return explicit;
  }
  const dir = process.env.VPG_STATE_DIR ?? ".vegastack-pages/state";
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "vegastack-pages.sqlite");
}

export async function findNodeMigrationsDir(): Promise<string | null> {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const candidates = [
    process.env.VPG_DB_MIGRATIONS_DIR,
    path.resolve(process.cwd(), "packages/db/migrations"),
    path.resolve(process.cwd(), "../../packages/db/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) return candidate;
  }
  return null;
}

export async function createNodeSqliteD1(): Promise<D1Database | null> {
  try {
    const sqliteSpecifier = "node:sqlite";
    const { DatabaseSync } = await import(/* @vite-ignore */ sqliteSpecifier);
    const database = new DatabaseSync(await nodeSqliteFilePath());
    const d1 = new NodeSqliteD1Database(database);
    await runNodeSqliteMigrations(d1);
    return d1;
  } catch (error) {
    console.warn(
      "Falling back to JSON runtime state because node:sqlite could not be initialized.",
      error,
    );
    return null;
  }
}

export async function runNodeSqliteMigrations(
  database: D1Database,
): Promise<void> {
  const pathSpecifier = "node:path";
  const fsSpecifier = "node:fs/promises";
  const path = await import(/* @vite-ignore */ pathSpecifier);
  const fs = await import(/* @vite-ignore */ fsSpecifier);
  const migrationsDir = await findNodeMigrationsDir();
  if (!migrationsDir) {
    throw new Error(
      "Could not find database migrations. Set VPG_DB_MIGRATIONS_DIR for Node/Docker deployments.",
    );
  }
  await database.exec?.("PRAGMA foreign_keys = ON");
  await database.exec?.(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
  );
  const appliedRows = await database
    .prepare("SELECT filename FROM schema_migrations")
    .all<{ filename: string }>();
  const applied = new Set(
    (Array.isArray(appliedRows)
      ? appliedRows
      : (appliedRows.results ?? [])
    ).map((row) => row.filename),
  );
  const files = ((await fs.readdir(migrationsDir)) as string[])
    .filter((file: string) => file.endsWith(".sql"))
    .sort((left: string, right: string) => left.localeCompare(right));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await database.exec?.("BEGIN");
    try {
      await database.exec?.(sql);
      await database
        .prepare(
          "INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)",
        )
        .bind(file, new Date().toISOString())
        .run();
      await database.exec?.("COMMIT");
    } catch (error) {
      await database.exec?.("ROLLBACK");
      throw error;
    }
  }
}
