import { describe, expect, it } from "vitest";
import { stripLeadingTitleFromSource } from "./page-source";

describe("stripLeadingTitleFromSource", () => {
  it("strips a markdown H1 that matches the title", () => {
    expect(
      stripLeadingTitleFromSource("# Plan\n\nbody", "Plan", "markdown"),
    ).toBe("body");
  });

  it("strips an MDX H1 that matches the title", () => {
    expect(stripLeadingTitleFromSource("# Plan\n\nbody", "Plan", "mdx")).toBe(
      "body",
    );
  });

  it("strips an HTML <h1> that matches the title", () => {
    expect(
      stripLeadingTitleFromSource("<h1>Plan</h1>\n<p>body</p>", "Plan", "html"),
    ).toBe("<p>body</p>");
  });

  it("leaves a non-matching H1 untouched", () => {
    expect(
      stripLeadingTitleFromSource("# Introduction\n\nbody", "Plan", "markdown"),
    ).toBe("# Introduction\n\nbody");
  });

  it("matches case-insensitively + tolerates trailing closer", () => {
    expect(
      stripLeadingTitleFromSource(
        "#  q3 PLAN  #\n\nbody",
        "Q3 Plan",
        "markdown",
      ),
    ).toBe("body");
  });

  it("preserves frontmatter before stripping body H1", () => {
    expect(
      stripLeadingTitleFromSource(
        "---\ntitle: Plan\n---\n\n# Plan\n\nbody",
        "Plan",
        "markdown",
      ),
    ).toBe("---\ntitle: Plan\n---\nbody");
  });

  it("is a no-op when title is empty", () => {
    expect(stripLeadingTitleFromSource("# Plan\n\nbody", "", "markdown")).toBe(
      "# Plan\n\nbody",
    );
  });

  it("is a no-op when source is empty", () => {
    expect(stripLeadingTitleFromSource("", "Plan", "markdown")).toBe("");
  });

  it("leaves HTML body alone when the first element isn't h1", () => {
    expect(
      stripLeadingTitleFromSource("<p>intro</p><h1>Plan</h1>", "Plan", "html"),
    ).toBe("<p>intro</p><h1>Plan</h1>");
  });
});
