#!/usr/bin/env node
// Mirror the canonical public CLI version (set by Changesets on
// @vegastack/pages) into auxiliary files and private workspace packages, and
// aggregate package CHANGELOG entries into root CHANGELOG.md.
//
// Wired from package.json:scripts.version-sync as
//   "version-sync": "changeset version && node scripts/sync-version.mjs"
// so every `pnpm run version-sync` run inside the "Version Packages" PR
// propagates the new version end-to-end.
//
// Files touched:
//   - package.json (root) — version field
//   - apps/* and packages/*/package.json — private workspace version fields
//   - cli/vegastack-pages/package.json — generated optional dependency pins
//   - cli/vegastack-pages/Cargo.toml — [package].version
//   - CHANGELOG.md (root) — prepends an aggregated section for the new version

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// @vegastack/pages (the public CLI) is the canonical version source.
const cliPkgPath = join(repoRoot, "cli", "vegastack-pages", "package.json");
const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf8"));
const version = cliPkg.version;
console.log(`sync-version: target version = ${version}`);

syncRootPackageJson(version);
syncWorkspacePackageJsons(version);
syncCliOptionalDependencies(version);
syncCargoToml(version);
aggregateChangelog(version);

function syncRootPackageJson(version) {
  const path = join(repoRoot, "package.json");
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text);
  if (json.version === version) {
    console.log(`sync-version: ${path} already at ${version}`);
    return;
  }
  json.version = version;
  const trailing = text.endsWith("\n") ? "\n" : "";
  writeFileSync(path, JSON.stringify(json, null, 2) + trailing);
  console.log(`sync-version: ${path} -> ${version}`);
}

function syncWorkspacePackageJsons(version) {
  const dirs = enumeratePackageDirs(repoRoot).filter(
    (dir) => dir !== "cli/vegastack-pages",
  );
  for (const dir of dirs) {
    const path = join(repoRoot, dir, "package.json");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const json = JSON.parse(text);
    if (json.version === version) {
      console.log(`sync-version: ${path} already at ${version}`);
      continue;
    }
    json.version = version;
    const trailing = text.endsWith("\n") ? "\n" : "";
    writeFileSync(path, JSON.stringify(json, null, 2) + trailing);
    console.log(`sync-version: ${path} -> ${version}`);
  }
}

function syncCliOptionalDependencies(version) {
  const text = readFileSync(cliPkgPath, "utf8");
  const json = JSON.parse(text);
  const optionalDependencies = json.optionalDependencies ?? {};
  let changed = false;
  for (const name of Object.keys(optionalDependencies)) {
    if (!name.startsWith(`${json.name}-`)) continue;
    if (optionalDependencies[name] === version) continue;
    optionalDependencies[name] = version;
    changed = true;
  }
  if (!changed) {
    console.log(
      `sync-version: ${cliPkgPath} optional dependencies already at ${version}`,
    );
    return;
  }
  json.optionalDependencies = optionalDependencies;
  const trailing = text.endsWith("\n") ? "\n" : "";
  writeFileSync(cliPkgPath, JSON.stringify(json, null, 2) + trailing);
  console.log(
    `sync-version: ${cliPkgPath} optional dependencies -> ${version}`,
  );
}

function syncCargoToml(version) {
  const path = join(repoRoot, "cli", "vegastack-pages", "Cargo.toml");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  // Only replace the [package] block's version line; future sub-tables would
  // need their own anchor, but right now Cargo.toml has a single version.
  const updated = text.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
  if (updated === text) {
    console.log(`sync-version: ${path} already at ${version}`);
    return;
  }
  writeFileSync(path, updated);
  console.log(`sync-version: ${path} -> ${version}`);
}

function aggregateChangelog(version) {
  const dirs = enumeratePackageDirs(repoRoot);
  const sections = [];
  for (const dir of dirs) {
    const cl = join(repoRoot, dir, "CHANGELOG.md");
    if (!existsSync(cl)) continue;
    const entry = extractVersionSection(readFileSync(cl, "utf8"), version);
    if (!entry) continue;
    const pkgJson = join(repoRoot, dir, "package.json");
    if (!existsSync(pkgJson)) continue;
    const pkgName = JSON.parse(readFileSync(pkgJson, "utf8")).name;
    sections.push({ pkgName, entry });
  }

  if (sections.length === 0) {
    console.log("sync-version: no per-package CHANGELOG entries to aggregate");
    return;
  }

  const rootPath = join(repoRoot, "CHANGELOG.md");
  const header = "# Changelog\n\n";
  const existing = existsSync(rootPath)
    ? readFileSync(rootPath, "utf8")
    : header;
  if (
    existing.includes(`## ${version}\n`) ||
    existing.includes(`## [${version}]`)
  ) {
    console.log(`sync-version: root CHANGELOG.md already contains ${version}`);
    return;
  }

  const body = sections
    .map(
      ({ pkgName, entry }) =>
        `### ${pkgName}\n\n${demoteHeadings(entry).trim()}\n`,
    )
    .join("\n");
  const aggregated = `## ${version}\n\n${body}\n`;
  const rest = existing.startsWith(header)
    ? existing.slice(header.length)
    : existing;
  writeFileSync(rootPath, header + aggregated + "\n" + rest);
  console.log(
    `sync-version: root CHANGELOG.md -> aggregated ${sections.length} package entries for ${version}`,
  );
}

function enumeratePackageDirs(root) {
  const out = ["cli/vegastack-pages"];
  for (const parent of ["packages", "apps"]) {
    const p = join(root, parent);
    if (!existsSync(p)) continue;
    for (const name of readdirSync(p)) {
      const sub = join(p, name);
      if (statSync(sub).isDirectory()) out.push(`${parent}/${name}`);
    }
  }
  return out;
}

function extractVersionSection(text, version) {
  const lines = text.split("\n");
  const versionRe = new RegExp(`^##\\s+\\[?${escapeRegex(version)}\\]?(\\s|$)`);
  const nextHeader = /^##\s+/;
  let inSection = false;
  const out = [];
  for (const line of lines) {
    if (versionRe.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && nextHeader.test(line)) break;
    if (inSection) out.push(line);
  }
  return out.length ? out.join("\n") : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Demote `###` (and deeper) headings inside extracted per-package entries so
// they nest under our `### <pkg-name>` section in the root CHANGELOG.
function demoteHeadings(text) {
  return text
    .split("\n")
    .map((line) => (/^###+ /.test(line) ? "#" + line : line))
    .join("\n");
}
