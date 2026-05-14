import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["apps", "packages", "docs"];
const extensions = new Set([".css", ".astro", ".tsx", ".ts", ".md", ".mdx"]);
const allowedFiles = new Set([
  "packages/ui/src/styles.css",
  "apps/web/src/lib/standalone-theme.ts",
]);

const forbidden = [
  /#[0-9A-Fa-f]{3,8}\b/,
  /\brgba?\(/,
  /\bhsla?\(/,
  /\boklch\(/,
  /(?<!-)\blch\(/,
  /\blab\(/,
  /\bcolor-mix\(/,
  /\bAccentColor\b/,
  /(?:background|color|border(?:-color)?|fill|stroke)\s*:\s*(?:black|white)\b/,
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "dist" || entry === "node_modules" || entry === ".astro") {
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
      if (forbidden.some((pattern) => pattern.test(line))) {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    "Color token audit failed. Move raw colors into palette tokens.",
  );
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Color token audit passed.");
