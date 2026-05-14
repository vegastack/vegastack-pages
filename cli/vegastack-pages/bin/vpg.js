#!/usr/bin/env node
// Umbrella @vegastack/pages launcher.
//
// At install time, npm pulls in exactly one platform sub-package
// (@vegastack/pages-<platform>) via optionalDependencies, honoring its os/cpu
// constraints. Here we resolve that sub-package's binary at runtime.
//
// For local development (`pnpm --filter @vegastack/pages build`), the matching
// sub-package isn't published, so we fall back to dist/<platform>/vpg produced
// by scripts/build-native.mjs.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "vpg.exe" : "vpg";

const binary = resolveBinary();

if (!binary) {
  if (isVersionFlag(process.argv[2])) {
    console.log(`vpg ${pkg.version}-dev (no native binary)`);
    process.exit(0);
  }
  console.error(
    [
      `${pkg.name}: no native binary available for ${platform}.`,
      "",
      "Supported platforms: darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64.",
      "If you installed from npm, this usually means your platform isn't in optionalDependencies.",
      "For local dev, run `node scripts/build-native.mjs` inside cli/vegastack-pages first.",
    ].join("\n"),
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "version") args[0] = "--version";
const result = spawnSync(binary, args, { stdio: "inherit" });
process.exit(result.status ?? 1);

function resolveBinary() {
  // 1. Production: the matching optional sub-package
  const subName = `${pkg.name}-${platform}`;
  try {
    const req = createRequire(import.meta.url);
    const subPkgJson = req.resolve(`${subName}/package.json`);
    const candidate = join(dirname(subPkgJson), "bin", binaryName);
    if (existsSync(candidate)) return candidate;
  } catch {
    // sub-package not installed; fall through
  }

  // 2. Local development: build-native.mjs output
  const dev = join(root, "dist", platform, binaryName);
  if (existsSync(dev)) return dev;

  return null;
}

function isVersionFlag(arg) {
  return arg === "version" || arg === "--version" || arg === "-V";
}
