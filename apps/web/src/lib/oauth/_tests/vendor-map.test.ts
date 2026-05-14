import { describe, expect, it } from "vitest";
import { vendorForClient, VENDORS } from "../vendor-map";

describe("vendorForClient", () => {
  it("matches Claude by client name", () => {
    expect(
      vendorForClient({ clientName: "Claude", redirectUris: null }).id,
    ).toBe("claude");
  });

  it("matches Claude by redirect host", () => {
    expect(
      vendorForClient({
        clientName: "Unknown",
        redirectUris: ["https://claude.ai/api/oauth/callback"],
      }).id,
    ).toBe("claude");
  });

  it("matches ChatGPT by redirect host", () => {
    expect(
      vendorForClient({
        clientName: "GPT thing",
        redirectUris: ["https://chatgpt.com/oauth/callback"],
      }).id,
    ).toBe("chatgpt");
  });

  it("matches Cursor by client name prefix", () => {
    expect(
      vendorForClient({ clientName: "Cursor IDE", redirectUris: null }).id,
    ).toBe("cursor");
  });

  it("matches the vpg CLI by client name", () => {
    expect(
      vendorForClient({ clientName: "vpg CLI", redirectUris: null }).id,
    ).toBe("vpg-cli");
  });

  it("falls back to generic for unknown clients", () => {
    expect(
      vendorForClient({ clientName: "Bespoke Tool", redirectUris: null }).id,
    ).toBe("generic");
  });

  it("ships exactly one fallback vendor named 'generic'", () => {
    const fallbacks = VENDORS.filter((vendor) => vendor.matchers.length === 0);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.id).toBe("generic");
  });

  it("matches subdomains of claude.ai (e.g. console.claude.ai)", () => {
    expect(
      vendorForClient({
        clientName: "n/a",
        redirectUris: ["https://console.claude.ai/oauth/cb"],
      }).id,
    ).toBe("claude");
  });

  it("rejects malformed redirect URIs without throwing", () => {
    expect(
      vendorForClient({
        clientName: "Mystery",
        redirectUris: ["not-a-url", "::::"],
      }).id,
    ).toBe("generic");
  });
});
