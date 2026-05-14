import { Download, Ellipsis, FileCode2, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { standaloneRadius } from "../lib/radius-tokens";
import {
  standaloneFooterStyle,
  standaloneLine,
  standalonePalette,
  standaloneTypography,
} from "../lib/standalone-theme";

type ExportMenuProps = {
  canExportSource: boolean;
  pageId: string;
  title: string;
  sourceType: "markdown" | "mdx" | "html";
  renderedHtml: string;
};

declare global {
  interface Window {
    __vpgCurrentSource?: string;
  }
}

export function ExportMenu({
  canExportSource,
  pageId,
  title,
  sourceType,
  renderedHtml,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [currentSource, setCurrentSource] = useState<string | null>(null);
  const sourceLabel =
    sourceType === "html"
      ? "Export HTML"
      : sourceType === "mdx"
        ? "Export as MDX"
        : "Export as Markdown";
  const canExportPdf = sourceType !== "html";

  useEffect(() => {
    function onSourceChange(event: Event) {
      const next = (event as CustomEvent<{ source?: string }>).detail?.source;
      if (next !== undefined) setCurrentSource(next);
    }
    window.addEventListener("vpg:source-change", onSourceChange);
    return () =>
      window.removeEventListener("vpg:source-change", onSourceChange);
  }, []);

  if (!canExportSource && !canExportPdf) return null;

  async function exportSource() {
    const extension =
      sourceType === "html" ? "html" : sourceType === "mdx" ? "mdx" : "md";
    const liveSource =
      window.__vpgCurrentSource ?? currentSource ?? (await fetchSource(pageId));
    const body =
      sourceType === "html"
        ? withHtmlFooter(liveSource)
        : withMarkdownFooter(liveSource);
    downloadText(
      `${slugify(title)}.${extension}`,
      body,
      sourceType === "html" ? "text/html" : "text/markdown",
    );
    setOpen(false);
  }

  function exportPdf() {
    const html = createPrintDocument(title, renderedHtml);
    const url = URL.createObjectURL(
      new Blob([html], { type: "text/html;charset=utf-8" }),
    );
    const printWindow = window.open(url, "_blank", "width=900,height=1100");
    if (!printWindow) {
      URL.revokeObjectURL(url);
      return;
    }
    printWindow.opener = null;
    printWindow.addEventListener(
      "load",
      () => {
        printWindow.focus();
        window.setTimeout(() => {
          printWindow.print();
          URL.revokeObjectURL(url);
        }, 250);
      },
      { once: true },
    );
    setOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Export options"
          size="icon"
          type="button"
          variant="ghost"
        >
          <Ellipsis size={17} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {canExportSource ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void exportSource();
            }}
          >
            {sourceType === "html" ? (
              <FileCode2 size={15} aria-hidden="true" />
            ) : (
              <FileText size={15} aria-hidden="true" />
            )}
            <span>{sourceLabel}</span>
          </DropdownMenuItem>
        ) : null}
        {canExportPdf ? (
          <DropdownMenuItem onSelect={exportPdf}>
            <Download size={15} aria-hidden="true" />
            <span>Export as PDF</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function withMarkdownFooter(value: string) {
  return `${value.trimEnd()}\n\n---\n\nExported via VegaStack Pages\n`;
}

function withHtmlFooter(value: string) {
  const documentValue = new DOMParser().parseFromString(value, "text/html");
  const footer = documentValue.createElement("footer");
  footer.textContent = "Exported via VegaStack Pages";
  footer.setAttribute("style", standaloneFooterStyle());
  documentValue.body.append(footer);
  return `<!doctype html>\n${documentValue.documentElement.outerHTML}`;
}

function createPrintDocument(title: string, body: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 48px auto; max-width: 760px; color: ${standalonePalette.text}; ${standaloneTypography.body} }
      h1 { ${standaloneTypography.h1} }
      h2 { ${standaloneTypography.h2} }
      h3 { ${standaloneTypography.h3} }
      h4 { ${standaloneTypography.h4} }
      pre { overflow: auto; border-radius: ${standaloneRadius.code}; background: ${standalonePalette.surfaceMuted}; padding: 16px; ${standaloneTypography.pre} }
      code { font-family: ${standaloneTypography.code}; }
      img, svg { max-width: 100%; height: auto; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: ${standaloneLine.border}; padding: 6px 8px; }
      footer { ${standaloneFooterStyle()} }
    </style>
  </head>
  <body>
    <main>${body}</main>
    <footer>Exported via VegaStack Pages</footer>
  </body>
</html>`;
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function fetchSource(pageId: string) {
  const response = await fetch(withPageQuery(`/api/pages/${pageId}/source`));
  if (!response.ok) throw new Error("Source export failed");
  const payload = (await response.json()) as { source?: string };
  return payload.source ?? "";
}

function withPageQuery(path: string) {
  const url = new URL(path, window.location.origin);
  const current = new URLSearchParams(window.location.search);
  const workspaceId =
    current.get("workspace_id") ??
    document.querySelector<HTMLElement>("[data-vpg-page-editor]")?.dataset
      .workspaceId ??
    document.querySelector<HTMLElement>("[data-vpg-workspace-id]")?.dataset
      .vpgWorkspaceId;
  if (workspaceId) url.searchParams.set("workspace_id", workspaceId);
  return `${url.pathname}${url.search}`;
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "vegastack-page"
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
