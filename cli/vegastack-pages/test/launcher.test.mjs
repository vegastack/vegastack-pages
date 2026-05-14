import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("launcher reports version", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const result = spawnSync("node", ["bin/vpg.js", "version"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.ok(
    result.stdout === `vpg ${pkg.version}\n` ||
      result.stdout === `vpg ${pkg.version}-dev\n`,
  );
});

test("launcher resolves platform binaries without shell-specific assumptions", () => {
  const source = readFileSync(
    new URL("../bin/vpg.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /process\.platform === "win32" \? "vpg\.exe" : "vpg"/);
  assert.match(
    source,
    /const platform = `\$\{process\.platform\}-\$\{process\.arch\}`/,
  );
  assert.match(source, /createRequire\(import\.meta\.url\)/);
  assert.match(source, /req\.resolve\(`\$\{subName\}\/package\.json`\)/);
  assert.match(source, /join\(root, "dist", platform, binaryName\)/);
});
