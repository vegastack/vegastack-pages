#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  dropOptions,
  ensureDefaultServerArgs,
  hostFromArgs,
  localStateDir,
  localEnv,
  portFromArgs,
  printLocalSummary,
  serverBaseUrl,
  stripCommandSeparator,
  appDir,
} from "./local-env.mjs";

const inputArgs = stripCommandSeparator(process.argv.slice(2));
const port = portFromArgs(inputArgs);
const host = hostFromArgs(inputArgs);
const baseUrl = serverBaseUrl(inputArgs, port);
const astroArgs = ensureDefaultServerArgs(
  dropOptions(inputArgs, ["--base-url", "--public-url", "--url"]),
  { host, port },
);
const lockPath = join(localStateDir, `dev-server-${port}.lock`);

function readLock() {
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLock() {
  mkdirSync(localStateDir, { recursive: true });
  const current = readLock();
  if (
    current?.pid &&
    current.pid !== process.pid &&
    isProcessAlive(current.pid)
  ) {
    console.error(
      [
        "",
        `A VegaStack Pages dev server already appears to be running on port ${port}.`,
        `Existing wrapper PID: ${current.pid}`,
        "",
        "Stop that server first, then restart. Running two dev servers against",
        "the same Vite cache can break React island hydration and overlays.",
        "",
        `To stop it: kill ${current.pid}`,
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  writeFileSync(
    lockPath,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        baseUrl,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function cleanupLock() {
  const current = readLock();
  if (current?.pid === process.pid) {
    rmSync(lockPath, { force: true });
  }
}

writeLock();

printLocalSummary({ host, port, baseUrl });

const child = spawn("pnpm", ["exec", "astro", "dev", ...astroArgs], {
  cwd: appDir,
  env: localEnv({ baseUrl }),
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  cleanupLock();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanupLock();
    child.kill(signal);
  });
}

process.on("exit", cleanupLock);
