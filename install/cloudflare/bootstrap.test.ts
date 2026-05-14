import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  new URL("./bootstrap.mjs", import.meta.url),
  "utf8",
);

describe("Cloudflare bootstrap hygiene", () => {
  it("does not write misleading unused runtime secrets", () => {
    expect(bootstrap).not.toContain('putSecret("SESSION_SECRET"');
    expect(bootstrap).not.toContain('putSecret("MAGIC_LINK_SECRET"');
    expect(bootstrap).not.toContain('putSecret("SETUP_TOKEN_SECRET"');
  });

  it("does not print the generated setup token", () => {
    expect(bootstrap).not.toContain("Temporary setup token:");
    expect(bootstrap).not.toMatch(/console\.log\(`[^`]*\$\{setupToken\}/);
  });

  it("generates the GitHub backup cron trigger", () => {
    expect(bootstrap).toContain("VPG_GITHUB_SYNC_CRON");
    expect(bootstrap).toContain("triggers");
    expect(bootstrap).toContain("Cron trigger for GitHub backup");
  });

  it("keeps AWS SES sender config out of wrangler vars", () => {
    expect(bootstrap).toContain("if (!sesEmailEnabled)");
    expect(bootstrap).toContain('putSecret("VPG_EMAIL_FROM"');
    expect(bootstrap).toContain('putSecret("VPG_EMAIL_PROVIDER", "ses")');
  });
});
