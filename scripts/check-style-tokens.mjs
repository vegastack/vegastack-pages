import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["apps", "packages", "docs"];
const extensions = new Set([".css", ".astro", ".tsx", ".ts"]);
const allowedFiles = new Set([
  "packages/ui/src/styles.css",
  "apps/web/src/lib/standalone-theme.ts",
]);
const skippedDirectories = new Set([
  ".astro",
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const forbidden = [
  {
    label: "raw font-weight",
    regex: /\bfont-weight\s*:\s*\d+\b/,
  },
  {
    label: "raw line-height",
    regex: /\bline-height\s*:\s*\d+(?:\.\d+)?\b/,
  },
  {
    label: "raw letter-spacing",
    regex: /\bletter-spacing\s*:\s*-?\d+(?:\.\d+)?(?:em|rem|px)?\b/,
  },
  {
    label: "raw font-size",
    regex: /\bfont-size\s*:\s*\d+(?:\.\d+)?(?:px|rem|em)\b/,
  },
  {
    label: "raw font shorthand",
    regex:
      /\bfont\s*:\s*(?!(?:inherit|var\())(?=[^;]*\d)[^;]*(?:px|rem|em|\/\s*\d|\b[1-9]\d{2}\b)/,
  },
  {
    label: "raw JS font weight",
    regex: /\bfontWeight\s*:\s*(?:(?:["'`]\d)|\d)/,
  },
  {
    label: "raw JS font size",
    regex: /\bfontSize\s*:\s*["'`]\d+(?:\.\d+)?(?:px|rem|em)/,
  },
  {
    label: "raw JS line height",
    regex: /\blineHeight\s*:\s*["'`]\d+(?:\.\d+)?/,
  },
  {
    label: "raw JS letter spacing",
    regex: /\bletterSpacing\s*:\s*["'`]-?\d+(?:\.\d+)?(?:px|rem|em)?/,
  },
  {
    label: "raw border shorthand",
    regex:
      /\bborder(?:-(?:top|right|bottom|left))?\s*:\s*\d+(?:\.\d+)?px\s+(?:solid|dashed)\b/,
  },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (skippedDirectories.has(entry)) {
      continue;
    }

    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
      continue;
    }

    const ext = path.slice(path.lastIndexOf("."));
    if (extensions.has(ext)) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];

for (const scanRoot of scanRoots) {
  for (const file of walk(join(root, scanRoot))) {
    const rel = relative(root, file);
    if (allowedFiles.has(rel)) {
      continue;
    }

    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of forbidden) {
        if (rule.regex.test(line)) {
          violations.push(`${rel}:${index + 1} ${rule.label}: ${line.trim()}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    "Style token audit failed. Use typography and --vsk-line-* tokens instead of raw CSS values.",
  );
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Style token audit passed.");
