import { describe, expect, it } from "vitest";
import { parseVegastackPagesConfig, resolveEnvPlaceholders } from ".";

describe("config", () => {
  it("resolves environment placeholders", () => {
    expect(
      resolveEnvPlaceholders("account: ${CLOUDFLARE_ACCOUNT_ID}", {
        CLOUDFLARE_ACCOUNT_ID: "acc_1",
      }),
    ).toBe("account: acc_1");
  });

  it("parses config with secure defaults", () => {
    const config = parseVegastackPagesConfig(
      `
app:
  base_url: https://pages.example.com
runtime:
  target: cloudflare
`,
      {},
    );

    expect(config.app.name).toBe("vegastack-pages");
    expect(config.security.version_retention_days).toBe(30);
    expect(config.app.deployment_mode).toBe("self_hosted");
    expect(config.auth.magic_link.enabled).toBe(true);
    expect(config.auth.google_oauth.enabled).toBe(false);
    expect(config.auth.public_signup.enabled).toBe(false);
  });

  it("supports managed public signup configuration", () => {
    const config = parseVegastackPagesConfig(
      `
app:
  base_url: https://pages.vegastack.com
  deployment_mode: managed
runtime:
  target: cloudflare
auth:
  public_signup:
    enabled: true
`,
      {},
    );

    expect(config.app.deployment_mode).toBe("managed");
    expect(config.auth.public_signup.enabled).toBe(true);
    expect(config.auth.public_signup.create_workspace_on_signup).toBe(true);
  });
});
