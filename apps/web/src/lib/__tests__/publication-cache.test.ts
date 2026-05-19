// Tests for the publication-cache fast-path helpers (Phase G).
//
// Verifies the Cache-Control matrix, ETag computation, anonymous
// detection, and the password cookie helpers. The Cache API / R2 round
// trip is covered by the integration test elsewhere; these are pure
// unit tests on the helper functions.

import { describe, expect, it } from "vitest";
import {
  computeCacheControl,
  computeArtifactEtag,
  isAnonymousPublicRequest,
  publicationAllowsComments,
  publicationPasswordCookieName,
} from "../publication-cache";

describe("computeCacheControl matrix", () => {
  it("password-gated → private + Vary: Cookie", () => {
    const result = computeCacheControl({
      passwordHash: "argon:salt:hash",
      indexingEnabled: false,
    });
    expect(result.value).toBe("private, max-age=60");
    expect(result.vary).toBe("Cookie");
  });

  it("indexable public → long shared cache", () => {
    const result = computeCacheControl({
      passwordHash: null,
      indexingEnabled: true,
    });
    expect(result.value).toContain("public");
    expect(result.value).toContain("s-maxage=31536000");
    expect(result.value).toContain("stale-while-revalidate=60");
    expect(result.vary).toBeUndefined();
  });

  it("link-only public → short shared cache", () => {
    const result = computeCacheControl({
      passwordHash: null,
      indexingEnabled: false,
    });
    expect(result.value).toContain("public");
    expect(result.value).toContain("s-maxage=300");
    expect(result.value).not.toContain("s-maxage=31536000");
    expect(result.vary).toBeUndefined();
  });
});

describe("computeArtifactEtag", () => {
  it("changes when any of the three inputs change", () => {
    const base = computeArtifactEtag({
      contentHash: "abc",
      updatedAt: "2026-01-01T00:00:00.000Z",
      passwordGated: false,
    });
    const changedHash = computeArtifactEtag({
      contentHash: "xyz",
      updatedAt: "2026-01-01T00:00:00.000Z",
      passwordGated: false,
    });
    const changedTime = computeArtifactEtag({
      contentHash: "abc",
      updatedAt: "2026-01-02T00:00:00.000Z",
      passwordGated: false,
    });
    const gated = computeArtifactEtag({
      contentHash: "abc",
      updatedAt: "2026-01-01T00:00:00.000Z",
      passwordGated: true,
    });
    expect(base).toMatch(/^W\/"/);
    expect(base).not.toBe(changedHash);
    expect(base).not.toBe(changedTime);
    expect(base).not.toBe(gated);
  });

  it("survives a bad updatedAt string", () => {
    const result = computeArtifactEtag({
      contentHash: "abc",
      updatedAt: "garbage",
      passwordGated: false,
    });
    expect(result).toBe('W/"abc.x.o"');
  });
});

describe("isAnonymousPublicRequest", () => {
  function mockCookies(values: Record<string, string>) {
    return {
      get(name: string) {
        return values[name] ? { value: values[name] } : undefined;
      },
    } as never;
  }

  it("true when no cookies provided", () => {
    expect(isAnonymousPublicRequest(undefined)).toBe(true);
  });

  it("true when cookies object has no vpg_session", () => {
    expect(isAnonymousPublicRequest(mockCookies({}))).toBe(true);
  });

  it("false when vpg_session cookie present", () => {
    expect(
      isAnonymousPublicRequest(mockCookies({ vpg_session: "ses_abc" })),
    ).toBe(false);
  });
});

describe("publicationAllowsComments", () => {
  it("view: false", () => {
    expect(publicationAllowsComments("view")).toBe(false);
  });
  it("comment: true", () => {
    expect(publicationAllowsComments("comment")).toBe(true);
  });
  it("edit: true", () => {
    expect(publicationAllowsComments("edit")).toBe(true);
  });
});

describe("publicationPasswordCookieName", () => {
  it("sanitizes non-ascii characters from the id", () => {
    expect(publicationPasswordCookieName("pub_abc-123")).toBe(
      "vpg_pub_pub_abc-123",
    );
    expect(publicationPasswordCookieName("pub/../etc")).toBe("vpg_pub_pubetc");
  });
});
