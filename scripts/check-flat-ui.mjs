import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["apps", "packages", "docs"];
const extensions = new Set([".astro", ".css", ".ts", ".tsx"]);
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
    label: "Tailwind ring utility",
    regex:
      /(?:^|[\s"'`])(?:focus:|focus-visible:|hover:|active:|data-\[[^\]]+\]:|dark:)*ring(?:-|\/|\[|\b)/,
  },
  {
    label: "Tailwind shadow utility",
    regex:
      /(?:^|[\s"'`])(?:focus:|focus-visible:|hover:|active:|data-\[[^\]]+\]:|dark:)*shadow(?:-|\/|\[|\b)/,
  },
  {
    label: "Tailwind blue state color",
    regex:
      /(?:^|[\s"'`])(?:focus:|focus-visible:|hover:|active:|data-\[[^\]]+\]:|dark:)*(?:border|outline|ring|text|bg)-blue-\d{2,3}\b/,
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
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
      const boxShadow = line.match(/\bbox-shadow\s*:\s*([^;]+);/);
      if (
        boxShadow &&
        boxShadow[1].replace(/\s*!important\s*$/, "").trim() !== "none"
      ) {
        violations.push(
          `${rel}:${index + 1} non-flat box-shadow: ${line.trim()}`,
        );
      }

      const outline = line.match(/\boutline\s*:\s*([^;]+);/);
      if (outline) {
        const value = outline[1].replace(/\s*!important\s*$/, "").trim();
        if (value !== "0" && value !== "none") {
          violations.push(
            `${rel}:${index + 1} non-flat outline: ${line.trim()}`,
          );
        }
      }

      if (line.trim().startsWith("/*") || line.trim().startsWith("*")) {
        return;
      }

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
    "Flat UI audit failed. Use real --vsk-line-* borders and background states, not rings, shadows, or blue focus utilities.",
  );
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Flat UI audit passed.");
