// /img/[...key] route — R2-backed image proxy. Tests the key-prefix
// guard (only `attachments/*` allowed), the 304 ETag path, and the
// content-type + cache-control headers.

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../[...key]";
import { getObjectStore } from "../../../lib/runtime";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  if (!process.env.VPG_STATE_DIR) {
    process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-img-"));
  }
});

function makeCtx(url: string, headers: Record<string, string> = {}) {
  return {
    params: { key: url.replace(/^.*\/img\//, "").split("/") },
    request: new Request(`https://pages.example.test${url}`, { headers }),
    locals: {},
  } as never;
}

describe("/img/[...key] route", () => {
  it("rejects non-attachments prefixes with 404", async () => {
    const response = await GET(makeCtx("/img/pages/wks/pg/source-h.md"));
    expect(response.status).toBe(404);
  });

  it("returns 404 when the R2 object is missing", async () => {
    const response = await GET(makeCtx("/img/attachments/wks/missing.webp"));
    expect(response.status).toBe(404);
  });

  it("serves an uploaded attachment with the immutable cache header", async () => {
    const store = await getObjectStore();
    const key = "attachments/wks_test/abc123.webp";
    await store.put(key, "fakewebpbytes", { contentType: "image/webp" });

    const response = await GET(makeCtx(`/img/${key}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("etag")).toBeTruthy();
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const store = await getObjectStore();
    const key = "attachments/wks_test/etag.webp";
    await store.put(key, "etag-test", { contentType: "image/webp" });

    // First GET — read the ETag.
    const initial = await GET(makeCtx(`/img/${key}`));
    const etag = initial.headers.get("etag")!;
    expect(etag).toBeTruthy();

    // Second GET with If-None-Match — should 304.
    const revalidated = await GET(
      makeCtx(`/img/${key}`, { "if-none-match": etag }),
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
  });
});
