import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("npm package includes README and license", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const files = pack.files.map((file) => file.path).sort();
  assert.deepEqual(files, [
    "LICENSE",
    "README.md",
    "bin/vpg.js",
    "package.json",
  ]);
});

test("cross-build stages platform packages with license metadata", () => {
  const script = readFileSync(
    new URL("../scripts/cross-build.mjs", import.meta.url),
    "utf8",
  );

  assert.match(script, /from "node:path"/);
  assert.match(script, /delimiter/);
  assert.match(script, /files: \["bin\/", "LICENSE", "README\.md"\]/);
  assert.match(
    script,
    /copyFileSync\(join\(repoRoot, "LICENSE"\), join\(outDir, "LICENSE"\)\)/,
  );
  assert.match(script, /chmodSync\(binaryOut, 0o755\)/);
});

test("source manifest defers native optional packages until publish", () => {
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.bin.vpg, "bin/vpg.js");
  assert.equal(pkg.bin["vegastack-pages"], "bin/vpg.js");
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.scripts.install, undefined);
});

test("pack-platforms injects exactly the supported native packages", () => {
  const script = readFileSync(
    new URL("../scripts/pack-platforms.mjs", import.meta.url),
    "utf8",
  );

  for (const platform of [
    "darwin-x64",
    "darwin-arm64",
    "linux-x64",
    "linux-arm64",
    "win32-x64",
  ]) {
    assert.match(script, new RegExp(`"${platform}"`));
  }
  assert.match(script, /umbrella\.optionalDependencies = refreshed/);
  assert.match(script, /chmodSync\(binaryPath, 0o755\)/);
});

test("native build script uses platform path delimiters and Windows home fallback", () => {
  const script = readFileSync(
    new URL("../scripts/build-native.mjs", import.meta.url),
    "utf8",
  );

  assert.match(script, /delimiter/);
  assert.match(script, /process\.env\.USERPROFILE/);
  assert.doesNotMatch(script, /\}\.cargo\/bin:\$\{process\.env\.PATH/);
  assert.match(script, /process\.platform === "win32" \? "vpg\.exe" : "vpg"/);
  assert.match(script, /chmodSync\(target, 0o755\)/);
});
