import { renderMarkdown } from "@vegastack/pages-renderer";

export type EditableSourceType = "markdown" | "mdx" | "html";

export type SourceDiagnostic = {
  severity: "error" | "warning";
  line: number;
  code: string;
  message: string;
};

export async function validateEditableSource(input: {
  source: string;
  sourceType: EditableSourceType;
}) {
  const diagnostics = validateMermaidBlocks(input.source);

  if (input.sourceType !== "html") {
    try {
      await renderMarkdown(input.source);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        line: 1,
        code: "markdown_parse_error",
        message:
          error instanceof Error ? error.message : "Markdown parsing failed.",
      });
    }
  }

  return {
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    source_type: input.sourceType,
    diagnostics,
  };
}

export function validateMermaidBlocks(source: string): SourceDiagnostic[] {
  const diagnostics: SourceDiagnostic[] = [];
  const blockPattern = /```mermaid[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(source))) {
    const block = match[1] ?? "";
    const startLine = source.slice(0, match.index).split(/\r?\n/).length + 1;
    const lines = block.split(/\r?\n/);
    const firstMeaningfulLine =
      lines
        .find((line) => line.trim())
        ?.trim()
        .toLowerCase() ?? "";
    const isGraph = /^(graph|flowchart)\b/.test(firstMeaningfulLine);
    const isPie = firstMeaningfulLine.startsWith("pie");
    const isXyChart = firstMeaningfulLine.startsWith("xychart-beta");

    lines.forEach((line, index) => {
      const lineNumber = startLine + index;
      const labelMatches = [...line.matchAll(/\[[^\]]*]/g)].map(
        (item) => item[0],
      );
      if (isGraph) {
        for (const label of labelMatches) {
          if (hasEmoji(label)) {
            diagnostics.push({
              severity: "error",
              line: lineNumber,
              code: "mermaid_graph_emoji_label",
              message:
                "Mermaid graph labels cannot reliably contain emoji. Move the emoji outside the node label.",
            });
          }
          if (/[$+]/.test(label)) {
            diagnostics.push({
              severity: "error",
              line: lineNumber,
              code: "mermaid_graph_symbol_label",
              message:
                "Mermaid graph labels cannot reliably contain $ or +. Spell out the symbol or quote via a safer label.",
            });
          }
        }
      }
      if (isXyChart) {
        const axisMatch = /^\s*x-axis\s+\[(.*)]\s*$/.exec(line);
        if (axisMatch) {
          const values = axisMatch[1]!.split(",").map((value) => value.trim());
          if (values.some((value) => /^["'].*["']$/.test(value))) {
            diagnostics.push({
              severity: "error",
              line: lineNumber,
              code: "mermaid_xychart_quoted_axis",
              message:
                "xychart-beta x-axis labels should be bare identifiers, not quoted strings. Use labels like yr2018.",
            });
          }
          if (values.some((value) => /^\d/.test(value))) {
            diagnostics.push({
              severity: "error",
              line: lineNumber,
              code: "mermaid_xychart_numeric_axis",
              message:
                "xychart-beta numeric x-axis labels are fragile. Prefix them, for example yr2018.",
            });
          }
        }
      }
      if (isPie) {
        if (
          /^\s*pie\s+title\s+.*'.*$/.test(line) &&
          !/^\s*pie\s+title\s+".*"\s*$/.test(line)
        ) {
          diagnostics.push({
            severity: "error",
            line: lineNumber,
            code: "mermaid_pie_unquoted_apostrophe",
            message: "Wrap pie titles containing apostrophes in double quotes.",
          });
        }
        if (/^\s*"[^"]+"\s+:\s*/.test(line)) {
          diagnostics.push({
            severity: "warning",
            line: lineNumber,
            code: "mermaid_pie_spaced_colon",
            message:
              'Pie values are most reliable without a space before the colon, for example "A": 32.',
          });
        }
      }
    });
  }

  return diagnostics;
}

function hasEmoji(value: string) {
  return /\p{Extended_Pictographic}/u.test(value);
}
