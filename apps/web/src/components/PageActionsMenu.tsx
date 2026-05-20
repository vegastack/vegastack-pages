import {
  Check,
  Copy,
  Download,
  Ellipsis,
  FileCode2,
  FileText,
  FolderInput,
  History,
  LoaderCircle,
  MessageSquareText,
  PencilLine,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  dispatchPageFavoriteChange,
  persistPageFavorite,
  type FavoriteChangeDetail,
} from "../lib/page-favorites";
import { standaloneRadius } from "../lib/radius-tokens";
import {
  standaloneFooterStyle,
  standaloneLine,
  standalonePalette,
  standaloneTypography,
} from "../lib/standalone-theme";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import { MoveToFolderDialog } from "./MoveToFolderDialog";
import { queueTrashUndoToast } from "../lib/trash-toast-handoff";

type Props = {
  workspaceId: string;
  pageId: string;
  slugId: string;
  title: string;
  sourceType: "markdown" | "mdx" | "html";
  canEdit: boolean;
  canComment: boolean;
  canFavorite?: boolean;
  initialFavorited?: boolean;
  canRestoreVersions: boolean;
  canExportSource: boolean;
  autoOpen?: boolean;
  /** Pre-flattened folder list for the Move-to-folder modal. Omit
      when the caller can't read folders (the menu hides Move when
      empty + canEdit is false). */
  folders?: Array<{ id: string; path: string; name: string }>;
  /** Where to bounce after the user trashes the page they're viewing. */
  workspaceHref?: string;
};

type PageVersion = {
  id: string;
  pageId: string;
  sourceType: "markdown" | "mdx" | "html";
  label: string | null;
  createdReason: "manual" | "time_checkpoint" | "share_milestone" | "system";
  createdAt: string;
};

type VersionsPayload = {
  versions?: PageVersion[];
};

declare global {
  interface Window {
    __vpgCurrentSource?: string;
  }
}

export function PageActionsMenu({
  workspaceId,
  pageId,
  slugId,
  title,
  sourceType,
  canEdit,
  canComment,
  canFavorite = true,
  initialFavorited = false,
  canRestoreVersions,
  canExportSource,
  autoOpen = false,
  folders = [],
  workspaceHref = "/app",
}: Props) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [trashBusy, setTrashBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(autoOpen);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pinned, setPinned] = useState(initialFavorited);
  const [favoritePending, setFavoritePending] = useState(false);
  const [currentSource, setCurrentSource] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [historyStatus, setHistoryStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [restoreTarget, setRestoreTarget] = useState<PageVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    function onSourceChange(event: Event) {
      const next = (event as CustomEvent<{ source?: string }>).detail?.source;
      if (next !== undefined) setCurrentSource(next);
    }
    window.addEventListener("vpg:source-change", onSourceChange);
    return () =>
      window.removeEventListener("vpg:source-change", onSourceChange);
  }, []);

  useEffect(() => {
    function onEditState(event: Event) {
      const editable = Boolean(
        (event as CustomEvent<{ editable?: boolean }>).detail?.editable,
      );
      setEditing(editable);
    }
    window.addEventListener("vpg:edit-state", onEditState);
    return () => window.removeEventListener("vpg:edit-state", onEditState);
  }, []);

  useEffect(() => {
    setPinned(initialFavorited);
  }, [initialFavorited, workspaceId, pageId]);

  useEffect(() => {
    function syncFavorite(event: Event) {
      const detail = (event as CustomEvent<FavoriteChangeDetail>).detail;
      if (detail?.workspaceId !== workspaceId || detail.pageId !== pageId) {
        return;
      }
      setPinned(detail.favorited);
    }
    window.addEventListener("vpg:favorites-changed", syncFavorite);
    return () =>
      window.removeEventListener("vpg:favorites-changed", syncFavorite);
  }, [workspaceId, pageId]);

  useEffect(() => {
    if (!historyOpen) return;
    void loadVersions();
  }, [historyOpen, pageId]);

  useEffect(() => {
    if (!historyOpen) return;
    function onPageUpdated(event: Event) {
      const checkpointCreated = Boolean(
        (event as CustomEvent<{ checkpointCreated?: boolean }>).detail
          ?.checkpointCreated,
      );
      if (checkpointCreated) void loadVersions();
    }
    window.addEventListener("vpg:page-updated", onPageUpdated);
    return () => window.removeEventListener("vpg:page-updated", onPageUpdated);
  }, [historyOpen, pageId]);

  async function loadVersions() {
    setHistoryStatus("loading");
    try {
      const response = await fetch(
        withPageQuery(`/api/pages/${pageId}/versions`, workspaceId),
      );
      if (!response.ok) throw new Error("Version history failed");
      const payload = (await response.json()) as VersionsPayload;
      setVersions([...(payload.versions ?? [])].reverse());
      setHistoryStatus("idle");
    } catch {
      setHistoryStatus("error");
    }
  }

  async function copyLink() {
    const url = `${window.location.origin}/p/${slugId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked, no-op
    }
  }

  function toggleEdit() {
    window.__vpgEditIntent = true;
    window.dispatchEvent(new CustomEvent("vpg:toggle-edit", { detail: {} }));
  }

  function openComments() {
    window.dispatchEvent(new CustomEvent("vpg:open-comments", { detail: {} }));
  }

  async function toggleFavorite() {
    if (favoritePending) return;
    const next = !pinned;
    setFavoritePending(true);
    setPinned(next);
    dispatchPageFavoriteChange({
      workspaceId,
      pageId,
      slugId,
      title,
      favorited: next,
    });
    try {
      await persistPageFavorite(workspaceId, pageId, next);
    } catch {
      setPinned(!next);
      dispatchPageFavoriteChange({
        workspaceId,
        pageId,
        slugId,
        title,
        favorited: !next,
      });
    } finally {
      setFavoritePending(false);
    }
  }

  async function exportSource() {
    const extension =
      sourceType === "html" ? "html" : sourceType === "mdx" ? "mdx" : "md";
    const liveSource =
      window.__vpgCurrentSource ??
      currentSource ??
      (await fetchSource(pageId, workspaceId));
    const body =
      sourceType === "html"
        ? withHtmlFooter(liveSource)
        : withMarkdownFooter(liveSource);
    downloadText(
      `${slugify(title)}.${extension}`,
      body,
      sourceType === "html" ? "text/html" : "text/markdown",
    );
  }

  async function exportPdf() {
    const html = createPrintDocument(
      title,
      await currentRenderedHtml(pageId, workspaceId),
    );
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
  }

  async function softDeletePage() {
    if (trashBusy) return;
    setTrashBusy(true);
    setMenuOpen(false);
    try {
      const response = await fetch(
        `/api/pages/${pageId}/trash?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          payload?.error?.message ?? "Could not move the page to trash.",
        );
      }
      // The header trigger is always rendered ON the page being
      // trashed, so we always cross a hard navigation. Hand the toast
      // off via sessionStorage so the destination SonnerHost picks it
      // up + holds the full 10s window.
      queueTrashUndoToast({ pageId, workspaceId, slugId, title });
      window.location.assign(workspaceHref);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Move to trash failed.",
      );
    } finally {
      setTrashBusy(false);
    }
  }

  async function restorePageFromTrash() {
    try {
      const response = await fetch(
        `/api/pages/${pageId}/restore?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) {
        throw new Error("Could not restore the page.");
      }
      toast.success("Page restored");
      window.location.assign(`/p/${slugId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore failed.");
    }
  }

  async function restoreVersion(version: PageVersion) {
    setRestoring(true);
    try {
      const response = await fetch(
        withPageQuery(`/api/pages/${pageId}/versions`, workspaceId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version_id: version.id }),
        },
      );
      if (!response.ok) throw new Error("Version restore failed");
      toast.success("Version restored.");
      window.setTimeout(() => window.location.reload(), 150);
    } catch {
      toast.error("Restore failed.");
      setRestoring(false);
    }
  }

  const sourceLabel =
    sourceType === "html"
      ? "Export HTML"
      : sourceType === "mdx"
        ? "Export MDX"
        : "Export Markdown";
  const canExportPdf = sourceType !== "html";
  const showExport = canExportSource || canExportPdf;
  const showMobileActions = canEdit || canComment || canFavorite;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="vpg-pheader-btn"
            type="button"
            aria-label="Page actions"
            title="More"
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="vpg-pmenu"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          {canEdit ? (
            <DropdownMenuItem
              className={`vpg-pmenu-mobile-only${editing ? " is-editing" : ""}`}
              data-vpg-toggle-edit
              data-edit-label-ready="Edit page"
              data-edit-label-editing="Done editing"
              onSelect={toggleEdit}
            >
              {editing ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <PencilLine size={14} aria-hidden="true" />
              )}
              <span data-edit-label>
                {editing ? "Done editing" : "Edit page"}
              </span>
            </DropdownMenuItem>
          ) : null}

          {canComment ? (
            <DropdownMenuItem
              className="vpg-pmenu-mobile-only"
              onSelect={openComments}
            >
              <MessageSquareText size={14} aria-hidden="true" />
              <span>Comments</span>
            </DropdownMenuItem>
          ) : null}

          {canFavorite ? (
            <DropdownMenuItem
              className="vpg-pmenu-mobile-only"
              disabled={favoritePending}
              onSelect={() => {
                void toggleFavorite();
              }}
            >
              <Star size={14} aria-hidden="true" />
              <span>{pinned ? "Remove favorite" : "Add favorite"}</span>
            </DropdownMenuItem>
          ) : null}

          {showMobileActions ? (
            <DropdownMenuSeparator className="vpg-pmenu-mobile-separator" />
          ) : null}

          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void copyLink();
            }}
          >
            {copied ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            <span>{copied ? "Link copied" : "Copy link"}</span>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => {
              setHistoryOpen(true);
            }}
          >
            <History size={14} aria-hidden="true" />
            <span>Version history</span>
          </DropdownMenuItem>

          {canEdit ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setMoveOpen(true);
                }}
              >
                <FolderInput size={14} aria-hidden="true" />
                <span>Move page</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  void softDeletePage();
                }}
                disabled={trashBusy}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>Move to trash</span>
              </DropdownMenuItem>
            </>
          ) : null}

          {showExport ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Download size={14} aria-hidden="true" />
                  <span>Export</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className="vpg-pmenu-export"
                  collisionPadding={8}
                >
                  {canExportSource ? (
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        void exportSource();
                      }}
                    >
                      {sourceType === "html" ? (
                        <FileCode2 size={14} aria-hidden="true" />
                      ) : (
                        <FileText size={14} aria-hidden="true" />
                      )}
                      <span>{sourceLabel}</span>
                    </DropdownMenuItem>
                  ) : null}
                  {canExportPdf ? (
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        void exportPdf();
                      }}
                    >
                      <Download size={14} aria-hidden="true" />
                      <span>Export as PDF</span>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" className="version-history-sheet">
          <SheetHeader>
            <SheetTitle>Version history</SheetTitle>
            <SheetDescription>
              Checkpoints saved for this page.
            </SheetDescription>
          </SheetHeader>

          <div className="version-history-body" aria-live="polite">
            {historyStatus === "loading" && versions.length === 0 ? (
              <div className="version-history-state">
                <LoaderCircle size={16} aria-hidden="true" />
                <span>Loading history</span>
              </div>
            ) : null}

            {historyStatus === "error" ? (
              <div className="version-history-state" data-tone="error">
                <span>Version history could not load.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="subtle"
                  onClick={() => void loadVersions()}
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {historyStatus === "idle" && versions.length === 0 ? (
              <div className="version-history-empty">
                <History size={18} aria-hidden="true" />
                <p>No checkpoints yet.</p>
              </div>
            ) : null}

            {versions.length > 0 ? (
              <ol className="version-history-list">
                {versions.map((version) => (
                  <li key={version.id} className="version-history-item">
                    <div className="version-history-item-main">
                      <time dateTime={version.createdAt}>
                        {formatVersionDate(version.createdAt)}
                      </time>
                      <span>{labelForReason(version.createdReason)}</span>
                      {version.label ? <p>{version.label}</p> : null}
                    </div>
                    {canRestoreVersions ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRestoreTarget(version)}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                        <span>Restore</span>
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open && !restoring) setRestoreTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore version?</DialogTitle>
            <DialogDescription>
              The current page source will be replaced by this checkpoint. A new
              checkpoint is kept for the restored state.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={restoring}
              type="button"
              variant="ghost"
              onClick={() => setRestoreTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!restoreTarget || restoring}
              type="button"
              variant="primary"
              onClick={() => {
                if (restoreTarget) void restoreVersion(restoreTarget);
              }}
            >
              {restoring ? (
                <LoaderCircle size={14} aria-hidden="true" />
              ) : (
                <RotateCcw size={14} aria-hidden="true" />
              )}
              <span>{restoring ? "Restoring" : "Restore"}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {moveOpen ? (
        <MoveToFolderDialog
          pageId={pageId}
          workspaceId={workspaceId}
          title={title}
          folders={folders}
          onClose={(moved) => {
            setMoveOpen(false);
            if (moved) window.location.reload();
          }}
        />
      ) : null}
    </>
  );
}

declare global {
  interface Window {
    __vpgEditIntent?: boolean;
  }
}

async function currentRenderedHtml(pageId: string, workspaceId: string) {
  const prose = document.querySelector<HTMLElement>("[data-vpg-prose-static]");
  if (prose?.innerHTML.trim()) return prose.innerHTML;

  const response = await fetch(
    withPageQuery(`/api/pages/${pageId}/rendered`, workspaceId),
  );
  if (!response.ok) return "";
  const payload = (await response.json()) as { html?: string };
  return payload.html ?? "";
}

function withMarkdownFooter(value: string) {
  return `${value.trimEnd()}\n\n---\n\nExported via VegaStack Pages\n`;
}

function withHtmlFooter(value: string) {
  const doc = new DOMParser().parseFromString(value, "text/html");
  const footer = doc.createElement("footer");
  footer.textContent = "Exported via VegaStack Pages";
  footer.setAttribute("style", standaloneFooterStyle());
  doc.body.append(footer);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
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

async function fetchSource(pageId: string, workspaceId: string) {
  const response = await fetch(
    withPageQuery(`/api/pages/${pageId}/source`, workspaceId),
  );
  if (!response.ok) throw new Error("Source export failed");
  const payload = (await response.json()) as { source?: string };
  return payload.source ?? "";
}

function withPageQuery(path: string, workspaceId: string) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("workspace_id", workspaceId);
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

function formatVersionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function labelForReason(reason: PageVersion["createdReason"]) {
  if (reason === "manual") return "Manual checkpoint";
  if (reason === "time_checkpoint") return "Autosaved checkpoint";
  if (reason === "share_milestone") return "Share milestone";
  return "System checkpoint";
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
