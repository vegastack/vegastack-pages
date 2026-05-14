import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const scanRoots = ["."];
const allowedValueFiles = new Set([
  "apps/web/src/lib/radius-tokens.ts",
  "packages/ui/src/styles.css",
]);
const skippedFiles = new Set(["scripts/check-radius-tokens.mjs"]);
const skippedDirectories = new Set([
  ".agents",
  ".astro",
  ".git",
  ".vegastack-pages",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const extensions = new Set([
  ".astro",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".mjs",
  ".ts",
  ".tsx",
]);

const blockedPatterns = [
  {
    label: "hardcoded CSS radius property",
    regex:
      /\bborder(?:-(?:top|right|bottom|left)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius\s*:\s*(?:0\b|\d*\.?\d+(?:px|rem|em|%)|50%|9999px)/i,
  },
  {
    label: "hardcoded radius token declaration",
    regex:
      /--(?:vsk-)?[\w-]*radius[\w-]*\s*:\s*(?:0\b|\d*\.?\d+(?:px|rem|em|%)|50%|9999px)/i,
  },
  {
    label: "hardcoded JS borderRadius",
    regex:
      /\bborderRadius\s*:\s*["'`]?(?:0\b|\d*\.?\d+(?:px|rem|em|%)|50%|9999px)/i,
  },
  {
    label: "hardcoded Tailwind radius utility",
    regex: /\brounded(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|full)|-\[[^\]]+\])/,
  },
];

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skippedDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }

    const relativePath = path.relative(root, fullPath);
    if (
      !skippedFiles.has(relativePath) &&
      extensions.has(path.extname(entry.name))
    ) {
      yield fullPath;
    }
  }
}

function isAllowedTokenLine(relativePath, line) {
  if (!allowedValueFiles.has(relativePath)) {
    return false;
  }

  if (relativePath === "packages/ui/src/styles.css") {
    return /^\s*--(?:vsk-)?radius-[\w-]+:\s*/.test(line);
  }

  if (relativePath === "apps/web/src/lib/radius-tokens.ts") {
    return /^\s*(button|card|code):\s*"\d+(?:px|rem|em)",?$/.test(line);
  }

  return false;
}

const violations = [];

for (const scanRoot of scanRoots) {
  for await (const file of walk(path.join(root, scanRoot))) {
    const relativePath = path.relative(root, file);
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r?\n/);

    lines.forEach((line, index) => {
      if (isAllowedTokenLine(relativePath, line)) {
        return;
      }

      for (const pattern of blockedPatterns) {
        if (pattern.regex.test(line)) {
          violations.push({
            file: relativePath,
            line: index + 1,
            label: pattern.label,
            source: line.trim(),
          });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    "Hardcoded radius values found. Use semantic --vsk-radius-* tokens.",
  );
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.label}: ${violation.source}`,
    );
  }
  process.exit(1);
}

console.log("Radius token audit passed.");
