import { describe, expect, it } from "vitest";
import { buildSource, splitEditableSource } from "./page-editor-codemirror";

describe("page editor source helpers", () => {
  it("keeps frontmatter and hides the duplicate rendered title heading", () => {
    const source =
      "---\ntitle: API Review\ndescription: Test\n---\n\n# API Review\n\nBody";
    const parsed = splitEditableSource(source, "API Review", "markdown");

    expect(parsed.frontmatterRaw).toContain("title: API Review");
    expect(parsed.hiddenLeadingHeading).toBe("# API Review\n\n");
    expect(parsed.body).toBe("Body");
    expect(
      buildSource(
        parsed.frontmatterRaw,
        parsed.hiddenLeadingHeading + parsed.body,
      ),
    ).toBe(
      "---\ntitle: API Review\ndescription: Test\n---\n\n# API Review\n\nBody",
    );
  });

  it("leaves html source intact", () => {
    const parsed = splitEditableSource("<main>Raw</main>", "Raw", "html");

    expect(parsed).toEqual({
      body: "<main>Raw</main>",
      frontmatterRaw: "",
      hiddenLeadingHeading: "",
    });
  });
});
