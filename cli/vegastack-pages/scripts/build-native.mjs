#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "vpg.exe" : "vpg";
const cargo = process.env.CARGO ?? "cargo";
const cargoBin = process.env.CARGO_HOME
  ? join(process.env.CARGO_HOME, "bin")
  : process.env.HOME
    ? join(process.env.HOME, ".cargo", "bin")
    : process.env.USERPROFILE
      ? join(process.env.USERPROFILE, ".cargo", "bin")
      : null;

const result = spawnSync(
  cargo,
  ["build", "--release", "--manifest-path", join(root, "Cargo.toml")],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [cargoBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const source = join(root, "target", "release", binaryName);
if (!existsSync(source)) {
  console.error(`Expected native binary was not created at ${source}`);
  process.exit(1);
}

const targetDir = join(root, "dist", platform);
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, join(targetDir, binaryName));
console.log(`Built ${join(targetDir, binaryName)}`);
