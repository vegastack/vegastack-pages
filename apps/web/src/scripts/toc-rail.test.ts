import { describe, expect, it } from "vitest";
import { tocAnchorId, tocItems, type TocHeading } from "./toc-rail";

describe("tocItems", () => {
  it("keeps only h1, h2, and h3 headings in the app TOC", () => {
    const headings: TocHeading[] = [
      { depth: 1, htmlId: "user-content-title", slug: "title", text: "Title" },
      {
        depth: 2,
        htmlId: "user-content-code",
        slug: "code",
        text: "Code",
      },
      {
        depth: 3,
        htmlId: "user-content-api",
        slug: "api",
        text: "API",
      },
      {
        depth: 4,
        htmlId: "user-content-detail",
        slug: "detail",
        text: "Detail",
      },
    ];

    expect(tocItems(headings).map((heading) => heading.text)).toEqual([
      "Title",
      "Code",
      "API",
    ]);
  });

  it("prefers rendered html ids for topbar outline links", () => {
    expect(
      tocAnchorId({
        depth: 2,
        htmlId: "user-content-install",
        slug: "install",
        text: "Install",
      }),
    ).toBe("user-content-install");
    expect(tocAnchorId({ depth: 2, slug: "api", text: "API" })).toBe("api");
  });
});
