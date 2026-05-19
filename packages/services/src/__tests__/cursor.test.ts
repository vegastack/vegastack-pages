import { describe, expect, it } from "vitest";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.ts";

describe("cursor — encodeCursor", () => {
  it("round-trips a (updatedAt, id) pair through encode + decode", () => {
    const original = { updatedAt: "2026-05-19T12:34:56.789Z", id: "pg_abc123" };
    const token = encodeCursor(original);
    expect(token).toBeTruthy();
    expect(decodeCursor(token)).toEqual(original);
  });

  it("returns null when there is no next page", () => {
    expect(encodeCursor(null)).toBeNull();
  });

  it("produces URL-safe tokens (no +, /, =)", () => {
    const token = encodeCursor({
      updatedAt: "2026-05-19T12:34:56.789Z",
      id: "pg_abc/+/123==",
    });
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });
});

describe("cursor — decodeCursor", () => {
  it("returns null for missing input", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for malformed tokens rather than throwing", () => {
    // Caller treats a malformed cursor as 'no cursor' so tampering can't
    // produce a 500. Verification: arbitrary garbage decodes to null.
    expect(decodeCursor("not!valid!base64!")).toBeNull();
    expect(decodeCursor("YWJj")).toBeNull(); // "abc" — no pipe separator
    expect(decodeCursor(btoa("|missing-key"))).toBeNull(); // empty updatedAt
    expect(decodeCursor(btoa("only-key|"))).toBeNull(); // empty id
  });

  it("decodes via lastIndexOf so internal pipes don't corrupt the id slot", () => {
    // The serialized form is `${updatedAt}|${id}`; we split on the
    // RIGHTMOST pipe so a pathologically-pipe-containing updatedAt
    // doesn't truncate the id. In practice neither our updatedAt
    // (ISO timestamp) nor our id (`prefix_hex`) ever contains a pipe;
    // this test guards against future changes that introduce one.
    const token = encodeCursor({
      updatedAt: "2026-05-19T00:00:00.000Z|weird|stuff",
      id: "real_id",
    });
    expect(decodeCursor(token)).toEqual({
      updatedAt: "2026-05-19T00:00:00.000Z|weird|stuff",
      id: "real_id",
    });
  });
});

describe("cursor — clampLimit", () => {
  it("uses default when input is missing or non-finite", () => {
    expect(clampLimit(undefined, { default: 50, hardCap: 200 })).toBe(50);
    expect(clampLimit(NaN, { default: 50, hardCap: 200 })).toBe(50);
  });

  it("caps at hardCap when caller exceeds it", () => {
    expect(clampLimit(99_999, { default: 50, hardCap: 200 })).toBe(200);
  });

  it("floors at 1 — never returns zero or negative", () => {
    expect(clampLimit(0, { default: 50, hardCap: 200 })).toBe(1);
    expect(clampLimit(-5, { default: 50, hardCap: 200 })).toBe(1);
  });

  it("floors fractional values to integers", () => {
    expect(clampLimit(42.9, { default: 50, hardCap: 200 })).toBe(42);
  });
});
