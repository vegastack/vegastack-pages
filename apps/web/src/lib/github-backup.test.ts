import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeRootPath,
  planGitHubBackupDeletes,
  verifyGitHubInstallationForUser,
} from "./github-backup";

// Note: data-shape tests (folder layout, attachment mirroring, template
// mirroring) live alongside the services they touch in
// packages/services/__tests__ now that buildGitHubBackupFiles reads
// directly from D1. This file keeps the pure-function planning tests
// and the GitHub OAuth verification tests, which don't need a workspace
// or page fixture.

const githubEnvKeys = [
  "VPG_GITHUB_APP_ID",
  "VPG_GITHUB_APP_SLUG",
  "VPG_GITHUB_APP_PRIVATE_KEY",
  "VPG_GITHUB_APP_CLIENT_ID",
  "VPG_GITHUB_APP_CLIENT_SECRET",
] as const;

const originalGithubEnv = Object.fromEntries(
  githubEnvKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of githubEnvKeys) {
    const value = originalGithubEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function configureGithubAppEnv() {
  process.env.VPG_GITHUB_APP_ID = "42";
  process.env.VPG_GITHUB_APP_SLUG = "vegastack-pages-test";
  process.env.VPG_GITHUB_APP_PRIVATE_KEY = "unused";
  process.env.VPG_GITHUB_APP_CLIENT_ID = "client-id";
  process.env.VPG_GITHUB_APP_CLIENT_SECRET = "client-secret";
}

describe("GitHub backup planning", () => {
  it("validates root paths before writing to a repository", () => {
    expect(normalizeRootPath(" /docs ")).toBe("docs");
    expect(() => normalizeRootPath(".github")).toThrow(/unsafe/);
    expect(() => normalizeRootPath("docs//drafts")).toThrow(/unsafe/);
    expect(() => normalizeRootPath("../docs")).toThrow(/unsafe/);
  });

  it("plans deletions only from prior manifest-owned files", () => {
    expect(
      planGitHubBackupDeletes({
        previousManifest: {
          root_path: "docs",
          owned_files: [
            "docs/old.md",
            "docs/current.md",
            "README.md",
            ".vegastack-pages/manifest.json",
          ],
        },
        desiredPaths: new Set([
          "docs/current.md",
          ".vegastack-pages/manifest.json",
        ]),
      }),
    ).toEqual(["docs/old.md"]);

    expect(() =>
      planGitHubBackupDeletes({
        previousManifest: { owned_files: [".github/workflows/release.yml"] },
        desiredPaths: new Set(),
      }),
    ).toThrow(/unsafe/);
  });

  it("verifies installation callbacks against the installing GitHub user", async () => {
    configureGithubAppEnv();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "user-token" });
        }
        if (url.includes("/user/installations")) {
          return Response.json({
            total_count: 1,
            installations: [{ id: 123, app_id: 42 }],
          });
        }
        return new Response("unexpected", { status: 500 });
      });

    await expect(
      verifyGitHubInstallationForUser({
        code: "oauth-code",
        installationId: 123,
      }),
    ).resolves.toMatchObject({ id: 123, app_id: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects spoofed installation ids from GitHub callbacks", async () => {
    configureGithubAppEnv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "user-token" });
      }
      if (url.includes("/user/installations")) {
        return Response.json({
          total_count: 1,
          installations: [{ id: 999, app_id: 42 }],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(
      verifyGitHubInstallationForUser({
        code: "oauth-code",
        installationId: 123,
      }),
    ).rejects.toThrow(/could not be verified/);
  });
});
