// Global test setup — provides a node-mode SQLite D1 to every test
// process. Without this, route tests that call buildServiceContext()
// would see ctx.db === undefined and throw "ServiceContext.db is
// required by this service" at the first D1 read.
//
// Each test process gets its own temp VPG_STATE_DIR so state doesn't
// leak between concurrent tests. The directory is wiped on exit.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.VPG_RUNTIME) {
  process.env.VPG_RUNTIME = "node";
}
if (!process.env.VPG_STATE_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "vpg-vitest-"));
  process.env.VPG_STATE_DIR = dir;
  // Wipe on process exit. SIGTERM and natural exit both fire 'exit'.
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });
}
if (!process.env.VPG_EMAIL_PROVIDER) {
  process.env.VPG_EMAIL_PROVIDER = "console";
}
