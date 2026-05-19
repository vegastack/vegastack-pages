#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const sourceConfigPath = path.join(appDir, "dist/server/wrangler.json");
const prodDataConfigPath = path.join(
  appDir,
  "dist/server/wrangler.prod-data.json",
);

function getPort(args) {
  const index = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith("--port="));
  if (inline) return inline.split("=")[1];
  return process.env.PORT || "4322";
}

function markRemote(bindings) {
  return Array.isArray(bindings)
    ? bindings.map((binding) => ({ ...binding, remote: true }))
    : bindings;
}

function ensurePortArg(args, port) {
  if (
    args.includes("--port") ||
    args.includes("-p") ||
    args.some((arg) => arg.startsWith("--port="))
  ) {
    return args;
  }
  return ["--port", port, ...args];
}

const passthroughArgs = process.argv.slice(2);
const dryRun = passthroughArgs.includes("--dry-run");
const wranglerArgs = passthroughArgs.filter(
  (arg) => arg !== "--dry-run" && arg !== "--",
);
const port = getPort(wranglerArgs);
const baseUrl = process.env.VPG_BASE_URL || `http://127.0.0.1:${port}`;

const config = JSON.parse(await readFile(sourceConfigPath, "utf8"));
config.r2_buckets = markRemote(config.r2_buckets);
config.d1_databases = markRemote(config.d1_databases);
config.vars = {
  ...(config.vars ?? {}),
  VPG_BASE_URL: baseUrl,
  VPG_PROD_DATA_DEV: "true",
};
config.dev = {
  ...(config.dev ?? {}),
  ip: process.env.HOST || "127.0.0.1",
  local_protocol: "http",
  upstream_protocol: "http",
};

await writeFile(prodDataConfigPath, `${JSON.stringify(config, null, 2)}\n`);

console.warn(
  [
    "",
    "VegaStack Pages production-data dev mode",
    "This local Worker uses the production D1 database and R2 bucket.",
    "Writes from the local app will mutate production data.",
    `Local base URL: ${baseUrl}`,
    "",
  ].join("\n"),
);

if (dryRun) {
  console.log(`Wrote ${prodDataConfigPath}`);
  process.exit(0);
}

const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    prodDataConfigPath,
    ...ensurePortArg(wranglerArgs, port),
  ],
  {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
