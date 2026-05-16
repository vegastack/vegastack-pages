import { describe, expect, it } from "vitest";
import { loginRedirectTarget, safeLocalRedirectPath } from "./auth-redirects";

describe("safeLocalRedirectPath", () => {
  it("keeps local absolute paths", () => {
    expect(safeLocalRedirectPath("/oauth/authorize/resume")).toBe(
      "/oauth/authorize/resume",
    );
    expect(safeLocalRedirectPath("/app?workspace_id=wks_1#top")).toBe(
      "/app?workspace_id=wks_1#top",
    );
  });

  it("rejects external or malformed redirect targets", () => {
    expect(safeLocalRedirectPath("https://example.com")).toBe("/app");
    expect(safeLocalRedirectPath("//example.com")).toBe("/app");
    expect(safeLocalRedirectPath("/\\example.com")).toBe("/app");
    expect(safeLocalRedirectPath("")).toBe("/app");
    expect(safeLocalRedirectPath(null)).toBe("/app");
  });
});

describe("loginRedirectTarget", () => {
  it("does not bounce signed-in users back to the login page", () => {
    expect(loginRedirectTarget("/app/login")).toBe("/app");
  });
  it("keeps valid in-app targets", () => {
    expect(loginRedirectTarget("/app/settings/profile")).toBe(
      "/app/settings/profile",
    );
    expect(loginRedirectTarget("/p/some-page")).toBe("/p/some-page");
  });
  it("falls back to /app for unsafe redirect_to values", () => {
    expect(loginRedirectTarget("https://attacker.example")).toBe("/app");
    expect(loginRedirectTarget(null)).toBe("/app");
  });
});
