#!/usr/bin/env node
// Stitches downloaded matrix artifacts into npm-publish/<platform>/ layout
// and verifies that every platform required by the umbrella package's
// optionalDependencies is present + version-matched.
//
// actions/download-artifact@v4 with merge-multiple:false lands each artifact
// in a folder named after the artifact (e.g. npm-publish/cli-darwin-arm64/...).
// We flatten that to npm-publish/<platform>/...

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const stage = join(root, "npm-publish");
const umbrellaPath = join(root, "package.json");
const umbrella = JSON.parse(readFileSync(umbrellaPath, "utf8"));
const supportedPlatforms = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

if (!existsSync(stage)) {
  console.error(
    `pack-platforms: ${stage} does not exist — did build-cli-matrix run?`,
  );
  process.exit(1);
}

// 1. Flatten cli-<platform>/ → <platform>/
for (const name of readdirSync(stage)) {
  const path = join(stage, name);
  if (!statSync(path).isDirectory()) continue;
  if (name.startsWith("cli-")) {
    const target = join(stage, name.slice("cli-".length));
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(path, target);
    console.log(
      `pack-platforms: flatten ${name} -> ${name.slice("cli-".length)}`,
    );
  }
}

// 2. Discover staged platforms + version-check each
const expectedPlatforms = new Set(supportedPlatforms);

const found = new Set();
for (const name of readdirSync(stage)) {
  const dir = join(stage, name);
  if (!statSync(dir).isDirectory()) continue;
  const subPkgPath = join(dir, "package.json");
  if (!existsSync(subPkgPath)) continue;
  const sub = JSON.parse(readFileSync(subPkgPath, "utf8"));
  if (sub.version !== umbrella.version) {
    console.error(
      `pack-platforms: ${sub.name}@${sub.version} does not match umbrella ${umbrella.name}@${umbrella.version}`,
    );
    process.exit(1);
  }
  found.add(name);
  const binaryName = name.startsWith("win32") ? "vpg.exe" : "vpg";
  const binaryPath = join(dir, "bin", binaryName);
  if (existsSync(binaryPath) && !name.startsWith("win32")) {
    chmodSync(binaryPath, 0o755);
  }
  console.log(`pack-platforms: ok ${sub.name}@${sub.version} (${name})`);
}

// 3. Reconcile expected vs found
const missing = [...expectedPlatforms].filter((p) => !found.has(p));
const extra = [...found].filter((p) => !expectedPlatforms.has(p));
if (missing.length) {
  console.error(`pack-platforms: missing platforms: ${missing.join(", ")}`);
  process.exit(1);
}
if (extra.length) {
  console.warn(
    `pack-platforms: extra platforms (not in optionalDependencies): ${extra.join(", ")}`,
  );
}

// 4. Refresh umbrella's optionalDependencies to pin exact versions
const refreshed = {};
for (const platform of expectedPlatforms) {
  refreshed[`${umbrella.name}-${platform}`] = umbrella.version;
}
umbrella.optionalDependencies = refreshed;
writeFileSync(umbrellaPath, JSON.stringify(umbrella, null, 2) + "\n");
console.log(
  `pack-platforms: pinned umbrella optionalDependencies to ${umbrella.version} for ${expectedPlatforms.size} platforms`,
);
