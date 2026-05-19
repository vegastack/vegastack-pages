// Smoke + contract tests for the release binary's `--agent` mode.
//
// Verifies that:
//   * Network-unreachable doctor → exit 7 (VPG_NETWORK), structured JSON on
//     stderr, empty stdout.
//   * `vpg --version` works and matches package.json.
//   * `vpg pages --help` and `vpg --help` show the noun-first command tree.
//   * Missing required positional → clap error (exit ~2) on stderr.
//
// These run against the prebuilt `target/release/vpg` binary. If it's
// missing the tests skip cleanly so `pnpm test` won't fail on machines
// without a Rust toolchain.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const binary = resolve(root, "target/release/vpg");

const haveBinary = existsSync(binary);
// node:test treats any non-undefined `skip` value as a skip signal, including
// `null` and `false`. Use undefined when we want the test to actually run.
const skipReason = haveBinary
  ? undefined
  : "release binary not built (run `cargo build --release` first)";

function vpg(args) {
  return spawnSync(binary, args, { encoding: "utf8", timeout: 5000 });
}

test("--version matches Cargo manifest", { skip: skipReason }, () => {
  const cargo = readFileSync(resolve(root, "Cargo.toml"), "utf8");
  const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(version, "Cargo.toml must declare a version");
  const result = vpg(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), `vpg ${version}`);
});

test("`--help` lists the noun-first command tree", { skip: skipReason }, () => {
  const result = vpg(["--help"]);
  assert.equal(result.status, 0);
  for (const expected of [
    "login",
    "logout",
    "whoami",
    "search",
    "events",
    "validate",
    "doctor",
    "completions",
    "pages",
    "comments",
    "publish",
    "templates",
    "workspaces",
    "attachments",
    "--agent",
    "--json",
  ]) {
    assert.ok(
      result.stdout.includes(expected),
      `--help must mention "${expected}"`,
    );
  }
});

test(
  "`pages --help` lists the new subcommand set",
  { skip: skipReason },
  () => {
    const result = vpg(["pages", "--help"]);
    assert.equal(result.status, 0);
    for (const sub of [
      "create",
      "get",
      "update",
      "move",
      "restore",
      "versions",
      "wait",
    ]) {
      assert.ok(result.stdout.includes(sub), `pages --help missing "${sub}"`);
    }
  },
);

test(
  "`--agent` network error produces a structured JSON envelope on stderr with exit 7",
  { skip: skipReason },
  () => {
    // 127.0.0.1:9 is the discard port; the connection refuses immediately.
    const result = vpg([
      "--agent",
      "--base-url",
      "http://127.0.0.1:9",
      "doctor",
    ]);
    assert.equal(result.status, 7, "VPG_NETWORK exit code");
    assert.equal(result.stdout, "", "stdout must be empty on error");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.code, "VPG_NETWORK");
    assert.match(parsed.error.message, /sending request/i);
  },
);

test(
  "missing required positional argument produces a clap parser error (exit 2) on stderr",
  { skip: skipReason },
  () => {
    // `pages get` requires a <PAGE> positional.
    const result = vpg(["--agent", "pages", "get"]);
    assert.equal(result.status, 2, "clap parser exit code");
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /required arguments|<PAGE>/i);
  },
);

test(
  "`--agent` doctor against bad scheme returns VPG_NETWORK consistently",
  { skip: skipReason },
  () => {
    const result = vpg([
      "--agent",
      "--base-url",
      "http://invalid.localhost.test:9",
      "doctor",
    ]);
    assert.equal(result.status, 7);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.code, "VPG_NETWORK");
  },
);

test(
  "`--agent` errors are compact single-line JSON (audit cycle 5)",
  { skip: skipReason },
  () => {
    // The agent-mode contract is "one JSON object per line"; a multi-line
    // pretty-print breaks line-by-line parsers and is wasteful on wire.
    const result = vpg([
      "--agent",
      "--base-url",
      "http://127.0.0.1:9",
      "doctor",
    ]);
    assert.equal(result.status, 7);
    // stderr ends with a trailing newline; drop it before counting lines.
    const stripped = result.stderr.replace(/\n$/, "");
    assert.equal(
      stripped.split("\n").length,
      1,
      `--agent error envelope must be one line; got ${JSON.stringify(stripped)}`,
    );
    // And it must still be valid JSON.
    JSON.parse(stripped);
  },
);

test(
  "`--quiet --agent` still emits the data envelope (only suppresses interactive chatter)",
  { skip: skipReason },
  () => {
    // The previous --quiet behavior wiped the agent's data envelope too,
    // leaving piped scripts with zero stdout on success. The new
    // contract: --quiet only affects interactive chatter; agent/json
    // data is the actual result, never the chatter.
    const result = vpg([
      "--agent",
      "--quiet",
      "--base-url",
      "http://127.0.0.1:9",
      "doctor",
    ]);
    // Doctor with a bad URL fails (network) — stderr should still carry
    // the error envelope even with --quiet, because errors are not
    // suppressible chatter.
    assert.equal(result.status, 7);
    assert.match(result.stderr, /VPG_NETWORK/);
  },
);

test(
  "`pages get` resolves slug-id to pg_… (audit cycle 5)",
  { skip: skipReason },
  () => {
    // Smoke: invoking `pages get <slug>` against an unreachable URL
    // should produce a network error (or a slug-not-found 404), NOT a
    // clap parse error. The earlier code path concatenated the slug
    // straight into the URL, which still worked syntactically but
    // would produce a server-side 404 for any non-pg_ identifier.
    const result = vpg([
      "--agent",
      "--base-url",
      "http://127.0.0.1:9",
      "--workspace",
      "wks_smoke",
      "--token",
      "fake_token_just_for_parse",
      "pages",
      "get",
      "some-slug-id-1234",
    ]);
    // Whatever the exit code, the error must be VPG_NETWORK (because the
    // CLI is trying to resolve the slug via the API). Crucially, it must
    // NOT be exit 2 (clap validation) — that would mean the slug was
    // rejected by the parser before any HTTP attempt.
    assert.notEqual(result.status, 2, "must not be a clap validation error");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.code, "VPG_NETWORK");
  },
);
