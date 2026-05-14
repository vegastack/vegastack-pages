import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const publicDocs = [
  "README.md",
  "CONTRIBUTING.md",
  "install/cloudflare/README.md",
  "install/docker/README.md",
  "cli/vegastack-pages/README.md",
  "apps/web/src/content/docs/quickstart.md",
  "apps/web/src/content/docs/cloudflare.md",
  "apps/web/src/content/docs/docker.md",
  "apps/web/src/content/docs/mcp-and-cli.md",
  "apps/web/src/content/docs/templates.md",
  "apps/web/src/content/docs/backup-to-git.md",
  "apps/web/src/pages/index.astro",
];

describe("public docs hygiene", () => {
  it("does not reintroduce stale install or CLI commands", () => {
    const stalePatterns = [
      /pnpm dlx @vegastack\/pages init/,
      /vpg auth login/,
      /vpg deploy cloudflare/,
      /vpg create --workspace docs plan\.md/,
      /search_workspace/,
      /export_page/,
      /browser-based login/,
      /No separate agent(?:-level)? tokens/,
    ];

    for (const path of publicDocs) {
      const content = read(path);
      for (const pattern of stalePatterns) {
        expect(content, `${path} should not match ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("documents source-checkout deploy and setup-token handling consistently", () => {
    const root = read("README.md");
    const cloudflare = read("install/cloudflare/README.md");
    const quickstart = read("apps/web/src/content/docs/quickstart.md");

    for (const content of [root, cloudflare, quickstart]) {
      expect(content).toContain(
        "pnpm deploy:cloudflare -- --apply-migrations --deploy",
      );
      expect(content).toContain('VPG_SETUP_TOKEN="$(openssl rand -base64 32)"');
    }
    expect(cloudflare).toContain(
      "generates one and writes it as a Worker secret without printing it",
    );
    expect(cloudflare).toContain("https://developers.cloudflare.com/workers/");
    expect(cloudflare).toContain("https://developers.cloudflare.com/d1/");
    expect(cloudflare).toContain(
      "https://developers.cloudflare.com/r2/api/workers/workers-api-usage/",
    );
  });

  it("documents the agentic knowledge base feature surface", () => {
    const root = read("README.md");
    const gettingStarted = read("apps/web/src/content/docs/getting-started.md");
    const mcp = read("apps/web/src/content/docs/mcp-and-cli.md");
    const templates = read("apps/web/src/content/docs/templates.md");
    const backup = read("apps/web/src/content/docs/backup-to-git.md");
    const homepage = read("apps/web/src/pages/index.astro");

    for (const content of [root, gettingStarted, homepage]) {
      expect(content).toContain("Agentic Knowledge Base");
      expect(content).toContain("Markdown");
      expect(content).toContain("MDX");
      expect(content).toContain("HTML");
      expect(content).toContain("Backup to Git");
    }

    expect(root).toContain("https://pages.vegastack.com/mcp");
    expect(mcp).toContain("create_page_from_template");
    expect(mcp).toContain("update_comment_anchor");
    expect(templates).toContain("PRD");
    expect(templates).toContain("guidance");
    expect(backup).toContain(".vegastack-pages/manifest.json");
  });

  it("keeps GitHub backup configuration documented everywhere it is user-facing", () => {
    const variables = [
      "VPG_GITHUB_APP_ID",
      "VPG_GITHUB_APP_SLUG",
      "VPG_GITHUB_APP_PRIVATE_KEY",
      "VPG_GITHUB_APP_CLIENT_ID",
      "VPG_GITHUB_APP_CLIENT_SECRET",
    ];
    const docs = [
      read("install/cloudflare/README.md"),
      read("install/docker/README.md"),
      read("apps/web/src/content/docs/backup-to-git.md"),
      read("docs/specs/008-configuration-env.md"),
    ];

    for (const content of docs) {
      for (const variable of variables) {
        expect(content).toContain(variable);
      }
    }
  });

  it("keeps Docker docs aligned with Compose safety defaults", () => {
    const compose = read("install/docker/docker-compose.yml");
    const dockerReadme = read("install/docker/README.md");

    expect(compose).toContain(
      "VPG_SETUP_TOKEN: ${VPG_SETUP_TOKEN:?Set VPG_SETUP_TOKEN before starting}",
    );
    expect(compose).toContain(
      "VPG_BASE_URL: ${VPG_BASE_URL:-http://localhost:4321}",
    );
    expect(compose).toContain(
      "VPG_EMAIL_PROVIDER: ${VPG_EMAIL_PROVIDER:-console}",
    );
    expect(dockerReadme).toContain("VPG_SETUP_TOKEN");
    expect(dockerReadme).toContain("/data/state/vegastack-pages.sqlite");
    expect(dockerReadme).toContain("/data/objects");
  });
});
