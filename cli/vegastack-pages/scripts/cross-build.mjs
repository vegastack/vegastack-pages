#!/usr/bin/env node
// CI cross-build entrypoint. Invoked per matrix leg in
// .github/workflows/release.yml as:
//   node scripts/cross-build.mjs --target <rust-target> --platform <npm-platform>
//
// Produces:
//   npm-publish/<platform>/bin/vpg[.exe]   — the platform binary
//   npm-publish/<platform>/package.json    — the @vegastack/pages-<platform> manifest
//   npm-publish/<platform>/README.md       — short blurb
//
// The pack-platforms.mjs step in the publish job re-stitches downloaded
// artifacts into the same layout (it tolerates artifacts being unpacked into
// nested cli-<platform>/ folders by actions/download-artifact).

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
if (!args.target || !args.platform) {
  console.error(
    "usage: cross-build.mjs --target <rust-target> --platform <npm-platform>",
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repoRoot = resolve(root, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const isWindows = args.platform.startsWith("win32");
const binaryName = isWindows ? "vpg.exe" : "vpg";
const cargoBin = process.env.CARGO_HOME
  ? join(process.env.CARGO_HOME, "bin")
  : process.env.HOME
    ? join(process.env.HOME, ".cargo", "bin")
    : process.env.USERPROFILE
      ? join(process.env.USERPROFILE, ".cargo", "bin")
      : null;

console.log(
  `cross-build: ${pkg.name}@${pkg.version} target=${args.target} platform=${args.platform}`,
);

// 1. cargo build --release --target <rust-target>
const cargo = process.env.CARGO ?? "cargo";
const cargoArgs = [
  "build",
  "--release",
  "--manifest-path",
  join(root, "Cargo.toml"),
  "--target",
  args.target,
];
const cargoResult = spawnSync(cargo, cargoArgs, {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: [cargoBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  },
});
if (cargoResult.status !== 0) process.exit(cargoResult.status ?? 1);

const source = join(root, "target", args.target, "release", binaryName);
if (!existsSync(source)) {
  console.error(`cross-build: expected binary missing at ${source}`);
  process.exit(1);
}

// 2. Stage into npm-publish/<platform>/
const outDir = join(root, "npm-publish", args.platform);
const binDir = join(outDir, "bin");
const binaryOut = join(binDir, binaryName);
mkdirSync(binDir, { recursive: true });
copyFileSync(source, binaryOut);
if (!isWindows) chmodSync(binaryOut, 0o755);

// 3. Write the sub-package manifest
const [osName, cpuName] = platformToOsCpu(args.platform);
const subPkg = {
  name: `${pkg.name}-${args.platform}`,
  version: pkg.version,
  description: `Platform binary for ${pkg.name} (${args.platform}). Installed via optionalDependencies.`,
  license: pkg.license ?? "MIT",
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  os: [osName],
  cpu: [cpuName],
  bin: { vpg: `bin/${binaryName}` },
  files: ["bin/", "LICENSE", "README.md"],
  preferUnplugged: true,
  publishConfig: {
    registry: "https://registry.npmjs.org",
    access: "public",
    provenance: true,
  },
};
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(subPkg, null, 2) + "\n",
);
copyFileSync(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"));
writeFileSync(
  join(outDir, "README.md"),
  `# ${subPkg.name}\n\n${subPkg.description}\n\nDo not depend on this package directly — install \`${pkg.name}\` and let npm pick the right platform binary.\n`,
);

console.log(`cross-build: staged ${join(outDir, "bin", binaryName)}`);
console.log(`cross-build: wrote ${join(outDir, "package.json")}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--platform") out.platform = argv[++i];
  }
  return out;
}

function platformToOsCpu(platform) {
  // npm `os` values: "darwin" | "linux" | "win32" | ...
  // npm `cpu` values: "x64" | "arm64" | ...
  const [osName, cpuName] = platform.split("-");
  return [osName, cpuName];
}
