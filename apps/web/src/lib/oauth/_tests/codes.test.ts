import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  randomToken,
  randomUserCode,
  verifyPkceS256,
} from "../codes";

describe("base64UrlEncode", () => {
  it("emits URL-safe base64 without padding", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("randomToken", () => {
  it("produces high-entropy tokens (no collisions across 256 draws)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 256; i += 1) set.add(randomToken(32));
    expect(set.size).toBe(256);
  });

  it("encodes as URL-safe base64", () => {
    const token = randomToken(32);
    expect(token).not.toMatch(/[+/=]/);
  });
});

describe("randomUserCode", () => {
  it("emits an 8-character XXXX-XXXX user code (with a dash)", () => {
    const code = randomUserCode();
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  });

  it("uses only confusion-safe letters (no vowels)", () => {
    const code = randomUserCode().replace("-", "");
    expect(code).not.toMatch(/[AEIOUY]/);
  });
});

describe("verifyPkceS256", () => {
  it("accepts a matching code_verifier / code_challenge pair", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a mismatched pair", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await verifyPkceS256(verifier, "wrong")).toBe(false);
  });

  it("rejects when challenge length differs (constant-time guard)", async () => {
    expect(await verifyPkceS256("abcd", "x")).toBe(false);
  });
});
