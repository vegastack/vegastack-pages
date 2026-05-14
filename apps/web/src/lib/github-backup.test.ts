import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentService,
  pageService,
  templateService,
  workspaceService,
} from "./runtime";
import {
  buildGitHubBackupFiles,
  normalizeRootPath,
  planGitHubBackupDeletes,
  verifyGitHubInstallationForUser,
  type GitHubBackupConnection,
} from "./github-backup";

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

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function configureGithubAppEnv() {
  process.env.VPG_GITHUB_APP_ID = "42";
  process.env.VPG_GITHUB_APP_SLUG = "vegastack-pages-test";
  process.env.VPG_GITHUB_APP_PRIVATE_KEY = "unused";
  process.env.VPG_GITHUB_APP_CLIENT_ID = "client-id";
  process.env.VPG_GITHUB_APP_CLIENT_SECRET = "client-secret";
}

function connection(input: {
  workspaceId: string;
  includeAssets?: boolean;
  rootPath?: string;
}): GitHubBackupConnection {
  const now = new Date().toISOString();
  return {
    id: uniqueId("ghc"),
    workspaceId: input.workspaceId,
    installationId: 123,
    repoOwner: "acme",
    repoName: "docs",
    repoId: 456,
    branch: "main",
    rootPath: input.rootPath ?? "docs",
    includeAssets: input.includeAssets ?? false,
    enabled: true,
    lastStatus: "idle",
    lastSyncedAt: null,
    lastCommitSha: null,
    lastError: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("GitHub backup planning", () => {
  it("validates root paths before writing to a repository", () => {
    expect(normalizeRootPath(" /docs ")).toBe("docs");
    expect(() => normalizeRootPath(".github")).toThrow(/unsafe/);
    expect(() => normalizeRootPath("docs//drafts")).toThrow(/unsafe/);
    expect(() => normalizeRootPath("../docs")).toThrow(/unsafe/);
  });

  it("preserves folder structure and resolves page filename collisions", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "GitHub Backup Test",
    });
    workspaceService.createFolder({
      id: uniqueId("fld"),
      workspaceId: workspace.id,
      name: "Engineering",
    });
    const first = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "engineering",
      title: "API Guide",
      sourceType: "markdown",
      source: "# API Guide",
    });
    const second = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      folderPath: "engineering",
      title: "API Guide",
      sourceType: "markdown",
      source: "# API Guide duplicate",
    });

    const built = await buildGitHubBackupFiles(
      connection({ workspaceId: workspace.id }),
    );
    const paths = built.files.map((file) => file.path);

    expect(paths).toContain("docs/engineering/api-guide.md");
    expect(paths).toContain(
      `docs/engineering/api-guide-${second.page.slugId.slice(second.page.slugId.lastIndexOf("-") + 1)}.md`,
    );
    expect(built.manifest.pages.map((page) => page.id)).toEqual([
      first.page.id,
      second.page.id,
    ]);
  });

  it("mirrors templates and includes attachments only when enabled", async () => {
    const workspace = workspaceService.createWorkspace({
      id: uniqueId("wks"),
      name: "GitHub Asset Test",
    });
    const page = await pageService.createPage({
      id: uniqueId("pg"),
      workspaceId: workspace.id,
      title: "Asset Page",
      sourceType: "markdown",
      source: "# Asset Page",
    });
    await attachmentService.upload({
      page: page.page,
      filename: "diagram.svg",
      contentType: "image/svg+xml",
      base64Body: btoa("<svg viewBox='0 0 1 1'></svg>"),
    });
    const template = await templateService.createTemplate({
      workspaceId: workspace.id,
      name: "Release Notes",
      slug: "release-notes",
      category: "general",
      source: "# {{title}}",
    });

    const withoutAssets = await buildGitHubBackupFiles(
      connection({ workspaceId: workspace.id, includeAssets: false }),
    );
    const withAssets = await buildGitHubBackupFiles(
      connection({ workspaceId: workspace.id, includeAssets: true }),
    );

    expect(withoutAssets.manifest.assets).toHaveLength(0);
    expect(withAssets.manifest.assets[0]?.path).toContain(
      "docs/assets/asset-page-",
    );
    expect(withAssets.manifest.assets[0]?.path).toContain(
      withAssets.manifest.assets[0]?.id,
    );
    expect(withAssets.files.map((file) => file.path)).toContain(
      ".vegastack-pages/templates/general/release-notes.md",
    );
    expect(withAssets.manifest.templates[0]).toMatchObject({
      id: template.template.id,
      slug: "release-notes",
    });
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
