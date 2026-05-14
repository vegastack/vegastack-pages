import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["apps", "packages"];
const extensions = new Set([".css", ".astro", ".tsx", ".ts", ".mjs", ".js"]);
const skippedDirectories = new Set([
  ".astro",
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const externalRuntimeVars = new Set([
  "--depth",
  "--font-geist",
  "--font-geist-mono",
  "--radix-select-trigger-width",
  "--shiki-dark",
  "--shiki-light",
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) {
      continue;
    }

    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }

    if (extensions.has(path.slice(path.lastIndexOf(".")))) {
      files.push(path);
    }
  }
  return files;
}

const files = scanRoots.flatMap((scanRoot) => walk(join(root, scanRoot)));
const definitions = new Map();
const uses = [];

for (const file of files) {
  const relativePath = relative(root, file);
  const source = readFileSync(file, "utf8");

  for (const match of source.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)) {
    const name = `--${match[1]}`;
    const found = definitions.get(name) ?? [];
    found.push(relativePath);
    definitions.set(name, found);
  }

  for (const match of source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    uses.push({ name: match[1], file: relativePath });
  }
}

const missing = uses.filter(
  (use) => !definitions.has(use.name) && !externalRuntimeVars.has(use.name),
);

if (missing.length > 0) {
  console.error("CSS variable audit failed. Undefined variables found:");
  for (const use of missing) {
    console.error(`${use.file}: ${use.name}`);
  }
  process.exit(1);
}

console.log("CSS variable audit passed.");
