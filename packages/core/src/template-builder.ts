export type TemplateBuilderHeadingLevel = 2 | 3 | 4;

export type TemplateBuilderSection = {
  level?: TemplateBuilderHeadingLevel;
  heading: string;
  helpText?: string;
  guidance?: string;
  body?: string;
};

export type TemplateBuilderDocument = {
  title?: string;
  intro?: string;
  sections?: TemplateBuilderSection[];
};

const DEFAULT_TEMPLATE_TITLE = "{{ title }}";

function normalizeLevel(level: unknown): TemplateBuilderHeadingLevel {
  return level === 3 || level === 4 ? level : 2;
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function cleanGuidance(value: unknown): string {
  return cleanText(value)
    .replace(/^<!--\s*/i, "")
    .replace(/\s*-->\s*$/i, "")
    .replace(/^guidance:\s*/i, "")
    .trim();
}

function headingMarker(level: TemplateBuilderHeadingLevel): string {
  return "#".repeat(level);
}

export function emptyTemplateBuilder(): Required<TemplateBuilderDocument> {
  return {
    title: DEFAULT_TEMPLATE_TITLE,
    intro: "",
    sections: [
      {
        level: 2,
        heading: "Section",
        helpText: "",
        guidance: "Tell the agent what this section should contain.",
        body: "",
      },
    ],
  };
}

export function normalizeTemplateBuilder(
  builder: TemplateBuilderDocument | null | undefined,
): Required<TemplateBuilderDocument> {
  const fallback = emptyTemplateBuilder();
  if (!builder || typeof builder !== "object") return fallback;
  const title = cleanText(builder.title) || DEFAULT_TEMPLATE_TITLE;
  const intro = cleanText(builder.intro);
  const sourceSections = Array.isArray(builder.sections)
    ? builder.sections
    : [];
  const sections = sourceSections
    .map((section, index) => ({
      level: normalizeLevel(section.level),
      heading: cleanText(section.heading) || `Section ${index + 1}`,
      helpText: cleanText(section.helpText),
      guidance: cleanGuidance(section.guidance),
      body: cleanText(section.body),
    }))
    .filter((section) => section.heading.length > 0);
  return {
    title,
    intro,
    sections: sections.length > 0 ? sections : fallback.sections,
  };
}

export function templateBuilderToMarkdown(
  input: TemplateBuilderDocument | null | undefined,
): string {
  const builder = normalizeTemplateBuilder(input);
  const chunks: string[] = [`# ${builder.title}`];

  if (builder.intro) {
    chunks.push(builder.intro);
  }

  for (const section of builder.sections) {
    const lines = [
      `${headingMarker(normalizeLevel(section.level))} ${section.heading}`,
    ];
    if (section.helpText) lines.push("", section.helpText);
    if (section.guidance) {
      lines.push("", `<!-- guidance: ${section.guidance} -->`);
    }
    if (section.body) lines.push("", section.body);
    chunks.push(lines.join("\n"));
  }

  return `${chunks.join("\n\n")}\n`;
}

function parseGuidanceBlock(content: string): {
  helpText: string;
  guidance: string;
  body: string;
} {
  const trimmed = content.trim();
  const match = trimmed.match(/<!--\s*guidance:\s*([\s\S]*?)-->/i);
  if (!match || match.index === undefined) {
    return { helpText: "", guidance: "", body: trimmed };
  }
  const helpText = trimmed.slice(0, match.index).trim();
  const body = trimmed.slice(match.index + match[0].length).trim();
  return {
    helpText,
    guidance: cleanGuidance(match[1]),
    body,
  };
}

export function templateBuilderFromMarkdown(
  source: string,
): Required<TemplateBuilderDocument> {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let title = DEFAULT_TEMPLATE_TITLE;
  const sections: TemplateBuilderSection[] = [];
  const introLines: string[] = [];
  let active: {
    level: TemplateBuilderHeadingLevel;
    heading: string;
    lines: string[];
  } | null = null;

  function flushActive() {
    if (!active) return;
    const parsed = parseGuidanceBlock(active.lines.join("\n"));
    sections.push({
      level: active.level,
      heading: active.heading,
      helpText: parsed.helpText,
      guidance: parsed.guidance,
      body: parsed.body,
    });
    active = null;
  }

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    const beforeFirstContent =
      !active &&
      sections.length === 0 &&
      introLines.every((entry) => entry.trim() === "");
    if (h1 && beforeFirstContent) {
      title = h1[1].trim() || DEFAULT_TEMPLATE_TITLE;
      introLines.length = 0;
      continue;
    }

    const heading = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (heading) {
      flushActive();
      active = {
        level: heading[1].length as TemplateBuilderHeadingLevel,
        heading: heading[2].trim(),
        lines: [],
      };
      continue;
    }

    if (active) active.lines.push(line);
    else introLines.push(line);
  }

  flushActive();

  const normalized = normalizeTemplateBuilder({
    title,
    intro: introLines.join("\n").trim(),
    sections,
  });
  return normalized;
}
