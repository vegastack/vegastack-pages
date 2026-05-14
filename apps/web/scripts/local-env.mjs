import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const appDir = path.resolve(__dirname, "..");
export const repoRoot = path.resolve(appDir, "../..");
export const localRoot = path.join(repoRoot, ".vegastack-pages", "local");
export const localStateDir = path.join(localRoot, "state");
export const localObjectsDir = path.join(localRoot, "objects");
export const localSqlitePath = path.join(
  localStateDir,
  "vegastack-pages.sqlite",
);

export function stripCommandSeparator(args) {
  return args.filter((arg) => arg !== "--");
}

export function readOption(args, longName, shortName) {
  let value = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === longName || (shortName && arg === shortName)) {
      const next = args[index + 1];
      if (next && !next.startsWith("-")) value = next;
      continue;
    }
    if (arg.startsWith(`${longName}=`)) {
      value = arg.slice(longName.length + 1);
    }
  }
  return value;
}

export function hasOption(args, names) {
  return names.some((name) =>
    args.some((arg) => arg === name || arg.startsWith(`${name}=`)),
  );
}

export function dropOptions(args, namesWithValues = [], flagNames = []) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagNames.includes(arg)) continue;
    const inlineValueOption = namesWithValues.some((name) =>
      arg.startsWith(`${name}=`),
    );
    if (inlineValueOption) continue;
    if (namesWithValues.includes(arg)) {
      const next = args[index + 1];
      if (next && !next.startsWith("-")) index += 1;
      continue;
    }
    output.push(arg);
  }
  return output;
}

export function portFromArgs(args, fallback = "4322") {
  return readOption(args, "--port", "-p") ?? process.env.VPG_PORT ?? fallback;
}

export function hostFromArgs(args, fallback = "0.0.0.0") {
  return readOption(args, "--host") ?? process.env.HOST ?? fallback;
}

export function serverBaseUrl(args, port) {
  return (
    readOption(args, "--base-url") ??
    process.env.VPG_BASE_URL ??
    `http://127.0.0.1:${port}`
  );
}

export function localApiBaseUrl(args, port) {
  return (
    readOption(args, "--url") ??
    readOption(args, "--base-url") ??
    `http://127.0.0.1:${port}`
  ).replace(/\/$/, "");
}

export function resolvePublicUrl(args) {
  const value =
    readOption(args, "--public-url") ??
    process.env.VPG_PUBLIC_URL ??
    process.env.VPG_BASE_URL ??
    null;
  return value ? value.replace(/\/$/, "") : null;
}

export function localEnv({ baseUrl } = {}) {
  return {
    ...process.env,
    VPG_ADAPTER: "node",
    VPG_RUNTIME: "node",
    VPG_DEPLOYMENT_MODE: process.env.VPG_DEPLOYMENT_MODE ?? "self_hosted",
    VPG_PUBLIC_SIGNUP: process.env.VPG_PUBLIC_SIGNUP ?? "false",
    VPG_SETUP_TOKEN: process.env.VPG_SETUP_TOKEN ?? "dev-setup-token",
    VPG_STATE_DIR: process.env.VPG_STATE_DIR ?? localStateDir,
    VPG_SQLITE_PATH: process.env.VPG_SQLITE_PATH ?? localSqlitePath,
    VPG_OBJECT_STORE_DIR: process.env.VPG_OBJECT_STORE_DIR ?? localObjectsDir,
    VPG_EMAIL_PROVIDER: process.env.VPG_EMAIL_PROVIDER ?? "console",
    VPG_EMAIL_FROM_NAME: process.env.VPG_EMAIL_FROM_NAME ?? "VegaStack Pages",
    VPG_DEMO_SEED: process.env.VPG_DEMO_SEED ?? "false",
    VPG_BASE_URL: baseUrl ?? process.env.VPG_BASE_URL ?? undefined,
  };
}

export function ensureDefaultServerArgs(args, { host, port }) {
  const output = [...args];
  if (!hasOption(output, ["--host"])) {
    output.unshift(host);
    output.unshift("--host");
  }
  if (!hasOption(output, ["--port", "-p"])) {
    output.unshift(port);
    output.unshift("--port");
  }
  return output;
}

export function printLocalSummary({ host, port, baseUrl }) {
  console.warn(
    [
      "",
      "VegaStack Pages local Node backend",
      "Storage: local SQLite and filesystem objects",
      "Cloudflare: not used by this dev server",
      `SQLite: ${localSqlitePath}`,
      `Objects: ${localObjectsDir}`,
      `Setup token: ${process.env.VPG_SETUP_TOKEN ?? "dev-setup-token"}`,
      `Server: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
      `Base URL: ${baseUrl}`,
      "",
    ].join("\n"),
  );
}

export async function assertLocalNodeBackend(baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/local/status`);
  } catch (error) {
    throw new Error(
      `Could not reach the local dev server at ${baseUrl}. Start it with: pnpm dev -- --port 4322\n${String(
        error,
      )}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Local status check failed with HTTP ${response.status}. Make sure the server is running with pnpm dev, not pnpm dev:prod-data.`,
    );
  }
  const status = await response.json();
  if (
    status.adapter !== "node" ||
    status.runtime !== "node" ||
    status.prod_data_dev
  ) {
    throw new Error(
      `This endpoint is not the safe local Node backend: ${JSON.stringify(
        status,
      )}`,
    );
  }
  return status;
}

export function mapPublicUrl(localUrl, publicBaseUrl) {
  if (!publicBaseUrl) return null;
  try {
    const local = new URL(localUrl);
    return `${publicBaseUrl}${local.pathname}${local.search}${local.hash}`;
  } catch {
    return null;
  }
}
