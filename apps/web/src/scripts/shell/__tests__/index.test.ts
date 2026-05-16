// Shell controller unit tests (audit-cycle-3-findings.md F-019).
//
// The full bootShell() / navigate() flow requires a DOM; this suite
// covers the pure helpers (URL routing + endpoint construction) so the
// risky branches have at least baseline coverage before broader e2e
// coverage lands.

import { describe, expect, it } from "vitest";
import { payloadUrlFor, shouldHandle } from "../index";

describe("shell shouldHandle", () => {
  it("accepts /p/* and /f/* paths", () => {
    expect(shouldHandle(new URL("https://app.test/p/page-slug-abc"))).toBe(
      true,
    );
    expect(shouldHandle(new URL("https://app.test/f/folder-slug-abc"))).toBe(
      true,
    );
  });

  it("rejects everything else", () => {
    expect(shouldHandle(new URL("https://app.test/"))).toBe(false);
    expect(shouldHandle(new URL("https://app.test/app"))).toBe(false);
    expect(shouldHandle(new URL("https://app.test/docs/quickstart"))).toBe(
      false,
    );
    expect(shouldHandle(new URL("https://app.test/api/health"))).toBe(false);
    // Login/setup pages must not be intercepted.
    expect(shouldHandle(new URL("https://app.test/login"))).toBe(false);
    expect(shouldHandle(new URL("https://app.test/setup"))).toBe(false);
  });

  it("does not match prefixes like /papers or /faq", () => {
    expect(shouldHandle(new URL("https://app.test/papers"))).toBe(false);
    expect(shouldHandle(new URL("https://app.test/faq"))).toBe(false);
  });
});

describe("shell payloadUrlFor", () => {
  it("builds the page partial endpoint with workspace_id in query", () => {
    const out = payloadUrlFor(
      "wks_abc",
      new URL("https://app.test/p/intro-slug-1234"),
    );
    expect(out).toBe(
      "/api/workspaces/wks_abc/documents/page/intro-slug-1234?workspace_id=wks_abc",
    );
  });

  it("builds the folder partial endpoint with workspace_id in query", () => {
    const out = payloadUrlFor(
      "wks_abc",
      new URL("https://app.test/f/getting-started-5678"),
    );
    expect(out).toBe(
      "/api/workspaces/wks_abc/documents/folder/getting-started-5678?workspace_id=wks_abc",
    );
  });

  it("encodes workspace ids and refs to keep the URL safe", () => {
    const out = payloadUrlFor(
      "wks abc",
      new URL("https://app.test/p/has%20space"),
    );
    expect(out).toContain("wks%20abc");
    // The ref comes from the path so its existing encoding round-trips.
    expect(out).toContain("documents/page/");
  });

  it("returns null for paths the shell does not handle", () => {
    expect(
      payloadUrlFor("wks_abc", new URL("https://app.test/app")),
    ).toBeNull();
    expect(
      payloadUrlFor("wks_abc", new URL("https://app.test/docs/quickstart")),
    ).toBeNull();
  });
});
