// DocumentPayload — shared contract between SSR routes (apps/web/src/pages/
// p/[slugId].astro, f/[slugId].astro), the partial API endpoints
// (/api/workspaces/:wid/documents/{page,folder}/:ref), and the client-side
// shell controller.
//
// Both pages and folders produce a DocumentPayload at SSR time, embed it as
// initial state, and the shell controller swaps new payloads in on
// navigation. The partial endpoint returns the same shape so SSR and
// partial swaps never drift.
//
// Plan: docs/plans/007-instant-workspace-architecture.md §6.1.

import { hasPermission } from "@vegastack/pages-core";
import {
  commentService,
  favoriteService,
  pageService,
  workspaceService,
} from "./runtime";
import {
  resolveActorPermission,
  resolveFolderActorPermission,
  resolvePublicationForPage,
  type RequestActor,
} from "./access";
import { listVisibleFoldersForActor } from "./workspace-visibility";
import { buildWorkspaceNavigation } from "./workspace-navigation";
import { renderCachedMarkdown } from "./render-cache";

export type DocumentKind = "page" | "folder";

export type BreadcrumbItem = {
  id: string;
  kind: "workspace" | "folder" | "page";
  href: string;
  label: string;
};

export type DocumentPermissions = {
  canView: boolean;
  canEdit: boolean;
  canComment: boolean;
  canAdmin: boolean;
  // Role label for UI ("Owner", "Editor", "Commenter", "Viewer", "Guest").
  role: string;
};

export type DocumentCommentsStats = {
  open: number;
  resolved: number;
  // Null when the document has never received a comment.
  last_activity_at: string | null;
};

export type DocumentPublication = {
  status: "draft" | "published";
  visibility: "private" | "link" | "public";
  url: string | null;
  password_protected: boolean;
};

// Chunks the shell may need to lazy-load before rendering. The shell loads
// them in parallel with the swap so transitions feel instant.
export type FeatureChunk =
  | "mermaid"
  | "katex"
  | "cytoscape"
  | "wardley"
  | "codemirror";

export type DocumentPayload = {
  kind: DocumentKind;
  workspace: {
    id: string;
    slug: string;
    name: string;
  };
  page?: {
    id: string;
    slug_id: string;
    title: string;
    source_type: "markdown" | "mdx" | "html";
    content_hash: string;
    version_id: string;
    folder_id: string | null;
    folder_path: string | null;
    updated_at: string;
  };
  folder?: {
    id: string;
    slug_id: string;
    name: string;
    path: string;
    parent_folder_id: string | null;
    position: number;
  };
  header: {
    title: string;
    meta_html: string;
  };
  breadcrumb: {
    items: BreadcrumbItem[];
  };
  document_html: string;
  toc: Array<{ id: string; level: number; text: string }>;
  comments_stats: DocumentCommentsStats;
  favorite: boolean;
  permissions: DocumentPermissions;
  publication?: DocumentPublication;
  tree_version: string;
  feature_chunks: FeatureChunk[];
  cache_control: "private, no-store";
};

export type BuildDocumentPayloadInput =
  | { kind: "page"; ref: string; workspaceId: string }
  | { kind: "folder"; ref: string; workspaceId: string };

// Inspect rendered HTML for tokens that require lazy chunks. Cheap regex
// match; the shell uses this to preload chunks in parallel with DOM swap.
function detectFeatureChunks(html: string): FeatureChunk[] {
  const chunks: FeatureChunk[] = [];
  if (/data-mermaid-source|class="mermaid-block"/.test(html))
    chunks.push("mermaid");
  if (/class="(?:[^"]*\s)?(?:math|katex)\b|\$\$/.test(html))
    chunks.push("katex");
  if (/data-cytoscape|class="(?:[^"]*\s)?cytoscape\b/.test(html))
    chunks.push("cytoscape");
  if (/data-wardley|class="(?:[^"]*\s)?wardley\b/.test(html))
    chunks.push("wardley");
  return chunks;
}

function permissionsFor(
  actor: RequestActor,
  scope: { read: boolean; write: boolean; comment: boolean; admin: boolean },
  isPublicPublication: boolean,
): DocumentPermissions {
  let role = "Guest";
  if (scope.admin) role = "Owner";
  else if (scope.write) role = "Editor";
  else if (scope.comment) role = "Commenter";
  else if (scope.read) role = "Viewer";
  if (isPublicPublication && !actor.user) role = "Guest";
  return {
    canView: scope.read,
    canEdit: scope.write,
    canComment: scope.comment,
    canAdmin: scope.admin,
    role,
  };
}

// Build the payload for a page. The page lookup happens by slug_id first
// (matches the SSR route's getPageBySlugId), then falls back to page id so
// MCP and CLI callers that have pg_* refs work too. The optional
// `workspaceId` parameter enforces that the resolved page belongs to the
// requested workspace; pass it from any caller that already knows the
// scope (e.g., the workspace-scoped HTTP endpoint).
export async function buildPageDocumentPayload(
  ref: string,
  actor: RequestActor,
  workspaceId?: string,
): Promise<DocumentPayload | null> {
  const bySlug = await pageService.getPageBySlugId(ref);
  const pageWithSource = bySlug ?? (await pageService.getPage(ref));
  if (!pageWithSource) return null;

  const { page } = pageWithSource;
  if (workspaceId && page.workspaceId !== workspaceId) return null;
  const workspace = workspaceService.getWorkspace(page.workspaceId);
  if (!workspace) return null;

  const permission = resolveActorPermission({ actor, page });
  const scope = {
    read: hasPermission(permission, "read"),
    write: hasPermission(permission, "write"),
    comment: hasPermission(permission, "comment"),
    admin: hasPermission(permission, "admin"),
  };
  if (!scope.read) return null;

  const publication = resolvePublicationForPage(page) ?? undefined;
  // PublicationRecord doesn't carry a "visibility" flag; we derive it from
  // passwordHash + indexingEnabled. "public" = listed/indexable, "link" =
  // share-by-link (possibly password-gated), "private" = unpublished/revoked.
  const publicationActive = publication && !publication.revokedAt;
  const publicationVisibility: DocumentPublication["visibility"] =
    !publicationActive
      ? "private"
      : publication!.indexingEnabled && !publication!.passwordHash
        ? "public"
        : "link";
  const isPublicPublication = publicationVisibility !== "private";

  const isHtmlPage = page.sourceType === "html";
  const rendered = isHtmlPage
    ? {
        frontmatter: {} as Record<string, unknown>,
        headings: [] as Array<{ depth: number; htmlId: string; text: string }>,
        html: pageWithSource.source,
      }
    : await renderCachedMarkdown({
        pageId: page.id,
        contentHash: page.contentHash,
        source: pageWithSource.source,
      });

  const frontmatter = rendered.frontmatter as Record<string, unknown>;
  const title = isHtmlPage
    ? page.title
    : typeof frontmatter.title === "string"
      ? frontmatter.title
      : page.title || "Untitled";
  const description =
    !isHtmlPage && typeof frontmatter.description === "string"
      ? frontmatter.description
      : null;

  // Strip the leading H1 from the rendered body when it duplicates the title
  // (matches SSR behaviour at p/[slugId].astro:260-264).
  const headings = rendered.headings ?? [];
  const stripLeadingH1 =
    !isHtmlPage &&
    headings[0]?.depth === 1 &&
    headings[0].text.trim().toLowerCase() === title.trim().toLowerCase();
  const displayedHeadings = stripLeadingH1 ? headings.slice(1) : headings;
  const displayedHtml = stripLeadingH1
    ? rendered.html.replace(/^<h1[^>]*>.*?<\/h1>\s*/s, "")
    : rendered.html;

  // Breadcrumb: workspace -> ancestor folders -> page. Lightweight version
  // for the partial endpoint; SSR builds a richer cascade-sibling version
  // inline (see p/[slugId].astro:186-253). The shell only needs the path.
  const currentFolder = page.folderPath
    ? (workspaceService
        .listFolders(page.workspaceId)
        .find((folder) => folder.path === page.folderPath) ?? null)
    : null;
  const ancestors = currentFolder
    ? workspaceService.folderAncestors(currentFolder.id)
    : [];
  const breadcrumbItems: BreadcrumbItem[] = [
    {
      id: workspace.id,
      kind: "workspace",
      href: `/app?workspace_id=${encodeURIComponent(workspace.id)}`,
      label: workspace.name,
    },
    ...ancestors.map((folder) => ({
      id: folder.id,
      kind: "folder" as const,
      href: `/f/${folder.slugId}`,
      label: folder.name,
    })),
    {
      id: page.id,
      kind: "page" as const,
      href: `/p/${page.slugId}`,
      label: title,
    },
  ];

  // Comments stats. The shell uses these for the badge in the header.
  const threads = commentService.listForPage(page.id, "all");
  const open = threads.filter((entry) => entry.thread.status === "open").length;
  const resolved = threads.filter(
    (entry) => entry.thread.status === "resolved",
  ).length;
  const lastActivity =
    threads
      .map((entry) => entry.thread.updatedAt)
      .sort()
      .pop() ?? null;

  // Favorite state: only meaningful for authenticated actors.
  const favorite = actor.user
    ? favoriteService
        .listForWorkspace(actor.user.id, page.workspaceId)
        .some((entry) => entry.pageId === page.id)
    : false;

  // Tree version: hashed per (workspace, actor) so cache keys segment by
  // visibility. Public publication views use the page's content hash as
  // a stand-in tree version (no sidebar nav for public single-page view).
  const treeVersion = isPublicPublication
    ? `pub_${page.contentHash}`
    : buildWorkspaceNavigation(actor, workspace.id).treeVersion;

  // Header meta HTML mirrors what PageHeader.astro renders for description
  // and frontmatter chips. The partial endpoint emits the same content.
  const metaPieces: string[] = [];
  if (description) {
    metaPieces.push(
      `<p class="vpg-pheader-desc">${escapeHtml(description)}</p>`,
    );
  }

  // The shell controller swaps the inner content of <div id="vpg-document">
  // wholesale. That div contains: optional title H1, optional description
  // paragraph, optional metadata list, and the prose or HTML iframe body.
  // Editor host and other persistent UI live OUTSIDE the swap zone.
  //
  // SSR renders the same chunks via the [slugId].astro template; the two
  // must produce byte-identical output for content swaps to be flicker-free.
  const swapPieces: string[] = [];
  if (!isHtmlPage) {
    swapPieces.push(`<h1 class="prose-title">${escapeHtml(title)}</h1>`);
  }
  if (description) {
    swapPieces.push(
      `<p class="prose-description" data-vpg-description-static>${escapeHtml(description)}</p>`,
    );
  }
  if (Object.keys(frontmatter).length > 0 && !isHtmlPage) {
    const metaRows = Object.entries(frontmatter)
      .filter(([key]) => key !== "title" && key !== "description")
      .map(([key, value]) => {
        const rendered =
          typeof value === "string"
            ? escapeHtml(value)
            : escapeHtml(JSON.stringify(value));
        return `<div><dt>${escapeHtml(key)}</dt><dd>${rendered}</dd></div>`;
      });
    if (metaRows.length > 0) {
      swapPieces.push(
        `<dl class="metadata-list" aria-label="Page metadata" data-vpg-metadata-static>${metaRows.join("")}</dl>`,
      );
    }
  }
  if (!isHtmlPage) {
    swapPieces.push(
      `<div class="prose" data-context="app" data-vpg-prose data-vpg-prose-static>${displayedHtml}</div>`,
    );
  } else {
    // HTML pages use an iframe with srcdoc. The shell does not regenerate
    // the iframe — it leaves the HTML page's full-document handler to
    // recompose. Document_html here is the raw source which the SSR
    // template puts into the iframe via srcdoc. The shell swap for HTML
    // pages is therefore best-effort; full-page reload is the safe fallback.
    swapPieces.push(displayedHtml);
  }
  const swapHtml = swapPieces.join("\n");

  return {
    kind: "page",
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    page: {
      id: page.id,
      slug_id: page.slugId,
      title,
      source_type: page.sourceType as "markdown" | "mdx" | "html",
      content_hash: page.contentHash,
      version_id: page.versionId,
      folder_id: currentFolder?.id ?? null,
      folder_path: page.folderPath ?? null,
      updated_at: page.updatedAt,
    },
    header: {
      title,
      meta_html: metaPieces.join(""),
    },
    breadcrumb: { items: breadcrumbItems },
    document_html: swapHtml,
    toc: displayedHeadings.map((heading, index) => ({
      id: heading.htmlId ?? `h-${index}`,
      level: heading.depth,
      text: heading.text,
    })),
    comments_stats: { open, resolved, last_activity_at: lastActivity },
    favorite,
    permissions: permissionsFor(actor, scope, !!isPublicPublication),
    publication: publication
      ? {
          status: publicationActive ? "published" : "draft",
          visibility: publicationVisibility,
          url: publicationActive ? buildPublicationUrl(page.slugId) : null,
          password_protected: Boolean(publication.passwordHash),
        }
      : undefined,
    tree_version: treeVersion,
    feature_chunks: detectFeatureChunks(displayedHtml),
    cache_control: "private, no-store",
  };
}

// Build the payload for a folder. Folders render a child-page listing as
// their document_html; the shell swaps it identically to a page body.
// The optional `workspaceId` parameter enforces that the resolved folder
// belongs to the requested workspace.
export async function buildFolderDocumentPayload(
  ref: string,
  actor: RequestActor,
  workspaceId?: string,
): Promise<DocumentPayload | null> {
  const folder =
    workspaceService.getFolderBySlugId(ref) ?? workspaceService.getFolder(ref);
  if (!folder) return null;
  if (workspaceId && folder.workspaceId !== workspaceId) return null;

  const workspace = workspaceService.getWorkspace(folder.workspaceId);
  if (!workspace) return null;

  // Folder permissions resolved via the same helper the SSR route uses,
  // so reader-vs-editor distinctions match the legacy behaviour. The
  // partial endpoint's resolveFolderAccess gate has already proven the
  // actor can READ; we ask the same helper for the granular scope so the
  // shell renders the right action affordances.
  const permission = resolveFolderActorPermission({ actor, folder });
  const scope = {
    read: hasPermission(permission, "read"),
    write: hasPermission(permission, "write"),
    comment: hasPermission(permission, "comment"),
    admin: hasPermission(permission, "admin"),
  };

  // Filter ancestors by visibility — a folder may be reached via a
  // direct grant even when one of its ancestors is private to the
  // current actor. The breadcrumb should only include ancestors the
  // actor can actually see.
  const visibleFolders = listVisibleFoldersForActor(actor, workspace.id);
  const visibleFolderIds = new Set(visibleFolders.map((entry) => entry.id));
  const ancestors = workspaceService
    .folderAncestors(folder.id)
    .filter((entry) => visibleFolderIds.has(entry.id));
  const breadcrumbItems: BreadcrumbItem[] = [
    {
      id: workspace.id,
      kind: "workspace",
      href: `/app?workspace_id=${encodeURIComponent(workspace.id)}`,
      label: workspace.name,
    },
    ...ancestors.map((entry) => ({
      id: entry.id,
      kind: "folder" as const,
      href: `/f/${entry.slugId}`,
      label: entry.name,
    })),
    {
      id: folder.id,
      kind: "folder" as const,
      href: `/f/${folder.slugId}`,
      label: folder.name,
    },
  ];

  // Child listing. Skeleton HTML matches the existing folder view shape;
  // full visual fidelity comes from docs.css (already imported globally
  // once the CSS migration lands in Workstream E).
  const allFolders = workspaceService.listFolders(workspace.id);
  const childFolders = allFolders.filter(
    (entry) => entry.parentFolderId === folder.id,
  );
  const childPages = pageService
    .listPages(workspace.id)
    .filter((page) => page.folderPath === folder.path);

  const documentHtml =
    `<ul class="vpg-folder-children">` +
    childFolders
      .map(
        (entry) =>
          `<li class="vpg-folder-children__folder"><a href="/f/${escapeAttr(entry.slugId)}">${escapeHtml(entry.name)}</a></li>`,
      )
      .join("") +
    childPages
      .map(
        (page) =>
          `<li class="vpg-folder-children__page"><a href="/p/${escapeAttr(page.slugId)}">${escapeHtml(page.title)}</a></li>`,
      )
      .join("") +
    `</ul>`;

  const treeVersion = buildWorkspaceNavigation(actor, workspace.id).treeVersion;

  return {
    kind: "folder",
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    folder: {
      id: folder.id,
      slug_id: folder.slugId,
      name: folder.name,
      path: folder.path,
      parent_folder_id: folder.parentFolderId,
      position: folder.position,
    },
    header: {
      title: folder.name,
      meta_html: "",
    },
    breadcrumb: { items: breadcrumbItems },
    document_html: documentHtml,
    toc: [],
    comments_stats: { open: 0, resolved: 0, last_activity_at: null },
    favorite: false,
    permissions: permissionsFor(actor, scope, false),
    tree_version: treeVersion,
    feature_chunks: [],
    cache_control: "private, no-store",
  };
}

// Convenience dispatcher. The input carries the workspaceId the caller
// expects; the builders enforce that the resolved page/folder belongs
// to it. Endpoints still do their own workspace pre-check for defense
// in depth, but this enforces the contract advertised by the type.
export async function buildDocumentPayload(
  input: BuildDocumentPayloadInput,
  actor: RequestActor,
): Promise<DocumentPayload | null> {
  return input.kind === "page"
    ? buildPageDocumentPayload(input.ref, actor, input.workspaceId)
    : buildFolderDocumentPayload(input.ref, actor, input.workspaceId);
}

function buildPublicationUrl(slugId: string): string {
  const base = (process.env.VPG_BASE_URL ?? "https://pages.vegastack.com")
    .replace(/\/+$/, "")
    .replace(/\/app$/, "");
  return `${base}/p/${slugId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
