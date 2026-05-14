#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = resolve(root, "apps/web");
const configPath = resolve(
  root,
  process.env.VPG_CONFIG_PATH ?? "vegastack-pages.yaml",
);
const fileConfig = loadConfig(configPath);
const managedMode =
  process.argv.includes("--managed") ||
  process.env.VPG_DEPLOYMENT_MODE === "managed" ||
  fileConfig.app?.deployment_mode === "managed";
const deploymentMode = managedMode ? "managed" : "self_hosted";
const baseUrl = normalizeBaseUrl(
  process.env.VPG_BASE_URL ??
    fileConfig.app?.base_url ??
    (managedMode ? "https://pages.vegastack.com" : "https://pages.example.com"),
);
const homeMode =
  process.env.VPG_HOME_MODE ?? fileConfig.app?.home_mode ?? "landing";
const databaseName =
  process.env.VPG_D1_DATABASE_NAME ??
  fileConfig.cloudflare?.d1_database_name ??
  "vegastack_pages";
const bucketName =
  process.env.VPG_R2_BUCKET_NAME ??
  fileConfig.cloudflare?.r2_bucket_name ??
  "vegastack-pages-content";
const workerName =
  process.env.VPG_WORKER_NAME ??
  fileConfig.cloudflare?.worker_name ??
  "vegastack-pages";
const kvNamespaceName =
  process.env.VPG_KV_NAMESPACE_NAME ?? `${workerName}-sessions`;
const setupToken =
  process.env.VPG_SETUP_TOKEN ?? randomBytes(24).toString("base64url");
const customDomain =
  process.env.VPG_CUSTOM_DOMAIN ??
  fileConfig.cloudflare?.custom_domain ??
  (managedMode ? "pages.vegastack.com" : "");
const applyMigrations = process.argv.includes("--apply-migrations");
const deploy = process.argv.includes("--deploy");
const emailProvider = process.env.VPG_EMAIL_PROVIDER ?? "auto";
const cloudflareEmailEnabled =
  process.env.VPG_ENABLE_CLOUDFLARE_EMAIL === "true" ||
  emailProvider === "cloudflare" ||
  emailProvider === "cloudflare_email_service";

function loadConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_, name) => process.env[name] ?? "",
  );
  return parse(raw) ?? {};
}

function normalizeBaseUrl(value) {
  return String(value)
    .replace(/\/+$/, "")
    .replace(/\/app$/, "");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const details = options.capture
      ? `\n${result.stderr || result.stdout}`
      : "";
    throw new Error(`${command} ${args.join(" ")} failed.${details}`);
  }
  return result.stdout?.trim() ?? "";
}

function wrangler(args, options = {}) {
  return run("pnpm", ["exec", "wrangler", ...args], options);
}

function putSecret(name, value) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "secret", "put", name],
    {
      cwd: appDir,
      input: `${value}\n`,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${name} failed.`);
  }
}

function createD1() {
  const listOutput = wrangler(["d1", "list", "--json"], { capture: true });
  const existing = JSON.parse(listOutput).find?.(
    (database) => database.name === databaseName,
  );
  if (existing?.uuid || existing?.database_id || existing?.id) {
    console.log(`Using existing D1 database ${databaseName}.`);
    return existing.uuid ?? existing.database_id ?? existing.id;
  }

  const output = wrangler(["d1", "create", databaseName], { capture: true });
  const parsed = parseJsonOutput(output, null);
  const database = Array.isArray(parsed) ? parsed[0] : parsed;
  let databaseId =
    database?.uuid ??
    database?.database_id ??
    database?.id ??
    /database_id\s*=\s*"([^"]+)"/.exec(output)?.[1] ??
    /database_id\s*[:=]\s*([0-9a-f-]{36})/i.exec(output)?.[1] ??
    /id\s*[:=]\s*"?([0-9a-f-]{36})"?/i.exec(output)?.[1];
  if (!databaseId) {
    const refreshed = JSON.parse(
      wrangler(["d1", "list", "--json"], { capture: true }),
    );
    databaseId = refreshed.find?.(
      (database) => database.name === databaseName,
    )?.uuid;
  }
  if (!databaseId) throw new Error("Wrangler did not return a D1 database id.");
  return databaseId;
}

function createR2() {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "r2", "bucket", "create", bucketName],
    {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    console.warn(
      "R2 bucket creation failed. If it already exists, continuing with the configured name.",
    );
  }
}

function parseJsonOutput(output, fallback) {
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function createKV() {
  if (process.env.VPG_KV_NAMESPACE_ID) {
    console.log(
      `Using existing KV namespace ${process.env.VPG_KV_NAMESPACE_ID}.`,
    );
    return process.env.VPG_KV_NAMESPACE_ID;
  }

  const listOutput = wrangler(["kv", "namespace", "list"], { capture: true });
  const namespaces = parseJsonOutput(listOutput, []);
  const existing = Array.isArray(namespaces)
    ? namespaces.find(
        (namespace) =>
          namespace.title === kvNamespaceName ||
          namespace.name === kvNamespaceName,
      )
    : null;
  if (existing?.id) {
    console.log(`Using existing KV namespace ${kvNamespaceName}.`);
    return existing.id;
  }

  const output = wrangler(
    ["kv", "namespace", "create", kvNamespaceName, "--binding", "SESSION"],
    { capture: true },
  );
  const parsed = parseJsonOutput(output, null);
  let namespaceId =
    parsed?.id ??
    parsed?.[0]?.id ??
    /id\s*=\s*"([^"]+)"/.exec(output)?.[1] ??
    /id\s*[:=]\s*"?([0-9a-f]{32})"?/i.exec(output)?.[1];
  if (!namespaceId) {
    const refreshed = parseJsonOutput(
      wrangler(["kv", "namespace", "list"], { capture: true }),
      [],
    );
    namespaceId = refreshed.find?.(
      (namespace) =>
        namespace.title === kvNamespaceName ||
        namespace.name === kvNamespaceName,
    )?.id;
  }
  if (!namespaceId)
    throw new Error("Wrangler did not return a KV namespace id.");
  return namespaceId;
}

function writeWranglerConfig(databaseId, kvNamespaceId) {
  const emailFrom = process.env.VPG_EMAIL_FROM ?? "";
  const config = {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "./src/worker.ts",
    compatibility_date:
      fileConfig.cloudflare?.compatibility_date ??
      new Date().toISOString().slice(0, 10),
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    assets: {
      binding: "ASSETS",
      directory: "./dist/client",
    },
    observability: {
      enabled: true,
      head_sampling_rate: Number(
        process.env.VPG_OBSERVABILITY_SAMPLING_RATE ?? "1",
      ),
    },
    workers_dev: !customDomain,
    vars: {
      VPG_RUNTIME: "cloudflare",
      VPG_DEPLOYMENT_MODE: deploymentMode,
      VPG_PUBLIC_SIGNUP: managedMode ? "true" : "false",
      VPG_BASE_URL: baseUrl,
      VPG_HOME_MODE: homeMode,
      VPG_EMAIL_PROVIDER: emailProvider,
      VPG_EMAIL_FROM: emailFrom,
      VPG_EMAIL_FROM_NAME: process.env.VPG_EMAIL_FROM_NAME ?? "VegaStack Pages",
      VPG_GITHUB_APP_ID: process.env.VPG_GITHUB_APP_ID ?? "",
      VPG_GITHUB_APP_SLUG: process.env.VPG_GITHUB_APP_SLUG ?? "",
      VPG_GITHUB_SYNC_CRON: process.env.VPG_GITHUB_SYNC_CRON ?? "17 2 * * *",
    },
    triggers: {
      crons: [process.env.VPG_GITHUB_SYNC_CRON ?? "17 2 * * *"],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: "../../packages/db/migrations",
      },
    ],
    kv_namespaces: [
      {
        binding: "SESSION",
        id: kvNamespaceId,
      },
    ],
    r2_buckets: [
      {
        binding: "CONTENT",
        bucket_name: bucketName,
      },
    ],
  };
  if (cloudflareEmailEnabled) {
    config.send_email = [
      emailFrom
        ? {
            name: "EMAIL",
            allowed_sender_addresses: [emailFrom],
          }
        : {
            name: "EMAIL",
          },
    ];
  }
  if (customDomain) {
    config.routes = [{ pattern: customDomain, custom_domain: true }];
  }
  writeFileSync(
    resolve(appDir, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function assertGeneratedWranglerConfig() {
  const generatedPath = resolve(appDir, "dist/server/wrangler.json");
  if (!existsSync(generatedPath)) {
    throw new Error("Astro did not generate dist/server/wrangler.json.");
  }
  const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
  const missing = [];
  if (!generated.d1_databases?.some?.((binding) => binding.binding === "DB"))
    missing.push("D1 binding DB");
  if (!generated.r2_buckets?.some?.((binding) => binding.binding === "CONTENT"))
    missing.push("R2 binding CONTENT");
  if (
    !generated.kv_namespaces?.some?.((binding) => binding.binding === "SESSION")
  )
    missing.push("KV binding SESSION");
  if (
    cloudflareEmailEnabled &&
    !generated.send_email?.some?.((binding) => binding.name === "EMAIL")
  )
    missing.push("Email binding EMAIL");
  if (
    !generated.triggers?.crons?.includes?.(
      process.env.VPG_GITHUB_SYNC_CRON ?? "17 2 * * *",
    )
  )
    missing.push("Cron trigger for GitHub backup");
  if (missing.length > 0) {
    throw new Error(
      `Generated Astro/Cloudflare deploy config is missing: ${missing.join(", ")}. Ensure apps/web/wrangler.jsonc exists before running astro build.`,
    );
  }
}

console.log("Checking Wrangler...");
wrangler(["--version"]);
console.log("Validating Cloudflare authentication...");
wrangler(["whoami"]);

console.log("Creating Cloudflare resources...");
const databaseId = process.env.VPG_D1_DATABASE_ID ?? createD1();
const kvNamespaceId = createKV();
createR2();
writeWranglerConfig(databaseId, kvNamespaceId);

console.log("Building Astro app...");
run("pnpm", ["--filter", "@vegastack/pages-web", "build"]);
assertGeneratedWranglerConfig();

if (applyMigrations) {
  console.log("Applying D1 migrations...");
  wrangler(["d1", "migrations", "apply", databaseName, "--remote"], {
    cwd: appDir,
  });
}

if (deploy && !applyMigrations && process.env.VPG_SKIP_MIGRATIONS !== "true") {
  throw new Error(
    "Refusing to deploy without --apply-migrations. Set VPG_SKIP_MIGRATIONS=true only for a verified no-op redeploy.",
  );
}

if (deploy) {
  console.log("Writing runtime secrets...");
  if (!managedMode) {
    console.log("Writing one-time setup token secret...");
    putSecret("VPG_SETUP_TOKEN", setupToken);
  }
  if (process.env.VPG_GITHUB_APP_PRIVATE_KEY) {
    console.log("Writing GitHub App private key secret...");
    putSecret(
      "VPG_GITHUB_APP_PRIVATE_KEY",
      process.env.VPG_GITHUB_APP_PRIVATE_KEY,
    );
  }
  console.log("Deploying Worker...");
  wrangler(["deploy"], { cwd: appDir });
} else {
  console.log("Cloudflare config written to apps/web/wrangler.jsonc.");
  console.log(
    "Run with --deploy to publish, and --apply-migrations to apply D1 migrations first.",
  );
}

console.log(`Deployment mode: ${deploymentMode}`);
console.log(
  managedMode
    ? `Managed signup URL: ${baseUrl}/app/signup`
    : `Self-host setup URL: ${baseUrl}/app/setup`,
);
if (!managedMode) {
  console.log("Setup token secret: written to Worker secret VPG_SETUP_TOKEN.");
}

if (!existsSync(resolve(appDir, "wrangler.jsonc"))) {
  throw new Error("Expected apps/web/wrangler.jsonc was not created.");
}
