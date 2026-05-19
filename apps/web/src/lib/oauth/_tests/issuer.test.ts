import { afterEach, describe, expect, it } from "vitest";
import { issuerForRequest, resourceForRequest, validateHost } from "../issuer";

function withAllowlistEnv(
  fn: () => void,
  options: { baseUrl?: string; mcpHosts?: string } = {},
) {
  const priorBaseUrl = process.env.VPG_BASE_URL;
  const priorMcp = process.env.VPG_MCP_ALLOWED_HOSTS;
  if (options.baseUrl !== undefined) process.env.VPG_BASE_URL = options.baseUrl;
  if (options.mcpHosts !== undefined)
    process.env.VPG_MCP_ALLOWED_HOSTS = options.mcpHosts;
  try {
    fn();
  } finally {
    if (priorBaseUrl === undefined) delete process.env.VPG_BASE_URL;
    else process.env.VPG_BASE_URL = priorBaseUrl;
    if (priorMcp === undefined) delete process.env.VPG_MCP_ALLOWED_HOSTS;
    else process.env.VPG_MCP_ALLOWED_HOSTS = priorMcp;
  }
}

describe("issuerForRequest", () => {
  afterEach(() => {
    delete process.env.VPG_BASE_URL;
    delete process.env.VPG_MCP_ALLOWED_HOSTS;
  });

  it("uses the request URL origin by default", () => {
    const request = new Request("https://pages.example.test/anything");
    expect(issuerForRequest(request)).toBe("https://pages.example.test");
  });

  it("ignores X-Forwarded-Host when no allowlist is configured", () => {
    // Defense against an unproxied deployment receiving a forged
    // X-Forwarded-Host. The forwarded host is trusted only when the
    // operator opts in via VPG_BASE_URL or VPG_MCP_ALLOWED_HOSTS.
    const request = new Request("http://internal.lan/anything", {
      headers: { "x-forwarded-host": "attacker.test" },
    });
    expect(issuerForRequest(request)).toBe("http://internal.lan");
  });

  it("honors X-Forwarded-Host with default https proto when allowlisted via VPG_BASE_URL", () => {
    withAllowlistEnv(
      () => {
        const request = new Request("http://internal.lan/anything", {
          headers: { "x-forwarded-host": "pages.example.test" },
        });
        expect(issuerForRequest(request)).toBe("http://pages.example.test");
      },
      { baseUrl: "https://pages.example.test" },
    );
  });

  it("honors X-Forwarded-Proto when paired with X-Forwarded-Host", () => {
    withAllowlistEnv(
      () => {
        const request = new Request("http://internal.lan/anything", {
          headers: {
            "x-forwarded-host": "pages.example.test",
            "x-forwarded-proto": "https",
          },
        });
        expect(issuerForRequest(request)).toBe("https://pages.example.test");
      },
      { baseUrl: "https://pages.example.test" },
    );
  });

  it("strips multi-value forwarded headers to the first entry", () => {
    withAllowlistEnv(
      () => {
        const request = new Request("http://internal.lan/anything", {
          headers: {
            "x-forwarded-host": "pages.example.test, evil.test",
            "x-forwarded-proto": "https,http",
          },
        });
        expect(issuerForRequest(request)).toBe("https://pages.example.test");
      },
      { baseUrl: "https://pages.example.test" },
    );
  });

  it("rejects X-Forwarded-Host not in the allowlist even with VPG_BASE_URL set", () => {
    withAllowlistEnv(
      () => {
        const request = new Request("http://internal.lan/anything", {
          headers: { "x-forwarded-host": "attacker.test" },
        });
        expect(issuerForRequest(request)).toBe("http://internal.lan");
      },
      { baseUrl: "https://pages.example.test" },
    );
  });

  it("accepts X-Forwarded-Host listed in VPG_MCP_ALLOWED_HOSTS", () => {
    withAllowlistEnv(
      () => {
        const request = new Request("http://internal.lan/anything", {
          headers: {
            "x-forwarded-host": "alt.example.test",
            "x-forwarded-proto": "https",
          },
        });
        expect(issuerForRequest(request)).toBe("https://alt.example.test");
      },
      { mcpHosts: "alt.example.test" },
    );
  });

  it("returns /mcp as the protected resource URL", () => {
    const request = new Request("https://docs.acme.test/mcp");
    expect(resourceForRequest(request)).toBe("https://docs.acme.test/mcp");
  });
});

describe("validateHost", () => {
  it("accepts a Host header that matches the request URL host", () => {
    const request = new Request("https://pages.example.test/mcp", {
      headers: { host: "pages.example.test" },
    });
    expect(validateHost(request)).toBeNull();
  });

  it("falls back to URL host when no Host header is present", () => {
    const request = new Request("https://pages.example.test/mcp");
    expect(validateHost(request)).toBeNull();
  });

  it("rejects a mismatched Host header (DNS rebinding shape)", () => {
    const request = new Request("https://pages.example.test/mcp", {
      headers: { host: "attacker.test" },
    });
    expect(validateHost(request)).toMatch(/does not match this server/);
  });

  it("accepts loopback Host headers regardless of request URL", () => {
    const request = new Request("https://pages.example.test/mcp", {
      headers: { host: "127.0.0.1:9999" },
    });
    expect(validateHost(request)).toBeNull();
  });

  it("accepts a Host present in VPG_MCP_ALLOWED_HOSTS", () => {
    const previous = process.env.VPG_MCP_ALLOWED_HOSTS;
    process.env.VPG_MCP_ALLOWED_HOSTS = "alt.example.test";
    try {
      const request = new Request("https://pages.example.test/mcp", {
        headers: { host: "alt.example.test" },
      });
      expect(validateHost(request)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.VPG_MCP_ALLOWED_HOSTS;
      else process.env.VPG_MCP_ALLOWED_HOSTS = previous;
    }
  });

  it("prefers X-Forwarded-Host over the bare Host header", () => {
    const request = new Request("https://pages.example.test/mcp", {
      headers: {
        "x-forwarded-host": "pages.example.test",
        host: "attacker.test",
      },
    });
    expect(validateHost(request)).toBeNull();
  });
});
