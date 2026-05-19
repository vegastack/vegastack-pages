import { describe, expect, it } from "vitest";
import { FavoriteService } from "./favorites";
import type { PageRecord } from "./page-service";

function page(input: Partial<PageRecord> = {}): PageRecord {
  return {
    id: input.id ?? "pg_1",
    workspaceId: input.workspaceId ?? "wks_1",
    folderPath: "",
    title: "Page",
    slug: "page",
    slugId: "page-000000000001",
    sourceType: "markdown",
    objectKeyCurrent: "pages/page.md",
    contentHash: "hash",
    versionId: "ver_1",
    renderedArtifactKey: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("FavoriteService", () => {
  it("stores favorites per user and workspace", () => {
    const service = new FavoriteService();
    const first = page({ id: "pg_1", workspaceId: "wks_1" });
    const second = page({ id: "pg_2", workspaceId: "wks_2" });

    service.add("usr_1", first);
    service.add("usr_1", second);
    service.add("usr_2", first);

    expect(
      service
        .listForWorkspace("usr_1", "wks_1")
        .map((favorite) => favorite.pageId),
    ).toEqual(["pg_1"]);
    expect(service.isFavorite("usr_1", "pg_1")).toBe(true);
    expect(service.isFavorite("usr_2", "pg_2")).toBe(false);
  });

  it("is idempotent and removes by user/page", () => {
    const service = new FavoriteService();
    const target = page();

    const first = service.add("usr_1", target);
    const second = service.add("usr_1", target);

    expect(second).toBe(first);
    expect(service.remove("usr_1", target.id)).toBe(true);
    expect(service.remove("usr_1", target.id)).toBe(false);
  });
});
