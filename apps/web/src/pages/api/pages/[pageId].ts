import { AppError, hasPermission } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../lib/access";
import { enrichThreads } from "../../../lib/comments-enrich";
import { renderCachedMarkdown } from "../../../lib/render-cache";
import { serializePublication } from "../../../lib/publication-api";
import {
  commentService,
  ensureSeedData,
  pageService,
} from "../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const ref = params.pageId ?? "";
    const page = await getPageByRef(ref);
    if (!page) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const include = parseInclude(url.searchParams.get("include"));
    const body: Record<string, unknown> = {
      page_id: page.page.id,
      workspace_id: page.page.workspaceId,
      title: page.page.title,
      slug_id: page.page.slugId,
      url: `/p/${page.page.slugId}`,
      folder_path: page.page.folderPath,
      source_type: page.page.sourceType,
      version_id: page.page.versionId,
      content_hash: page.page.contentHash,
      updated_at: page.page.updatedAt,
      permission: access.permission,
      open_comment_count: commentService.listForPage(page.page.id).length,
    };
    if (include.has("source")) {
      body.source = page.source;
      body.source_version_id = page.page.versionId;
      body.source_content_hash = page.page.contentHash;
    }
    if (include.has("rendered")) {
      const rendered =
        page.page.sourceType === "html"
          ? { html: "", headings: [], frontmatter: {}, frontmatterText: "" }
          : await renderCachedMarkdown({
              pageId: page.page.id,
              contentHash: page.page.contentHash,
              source: page.source,
            });
      body.rendered = {
        page_id: page.page.id,
        content_hash: page.page.contentHash,
        source_type: page.page.sourceType,
        html: rendered.html,
        render_mode:
          page.page.sourceType === "html" ? "sandboxed_html" : "html",
        headings: rendered.headings,
        frontmatter: rendered.frontmatter,
        frontmatter_text: rendered.frontmatterText,
      };
    }
    if (include.has("versions")) {
      const versions = pageService.listVersions(page.page.id);
      const limit = parseLimit(
        url.searchParams.get("versions_limit"),
        100,
        500,
      );
      body.versions = versions.slice(0, limit);
      body.versions_truncated = versions.length > limit;
    }
    if (include.has("comments")) {
      const threads = commentService.listForPage(page.page.id, "all");
      const limit = parseLimit(
        url.searchParams.get("comments_limit"),
        100,
        500,
      );
      body.threads = enrichThreads(threads.slice(0, limit));
      body.threads_truncated = threads.length > limit;
    }
    if (include.has("publication")) {
      if (!hasPermission(access.permission, "admin")) {
        throw new AppError(
          "PERMISSION_DENIED",
          "Publication details require admin access.",
          403,
        );
      }
      body.publication = serializePublication({
        type: "page",
        page: page.page,
        slugId: page.page.slugId,
      });
    }
    return Response.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return jsonAppError(error, "Page metadata failed.");
  }
};

async function getPageByRef(ref: string) {
  if (!ref) return null;
  if (ref.startsWith("pg_")) return pageService.getPage(ref);
  return pageService.getPageBySlugId(ref);
}

function parseInclude(value: string | null) {
  const allowed = new Set([
    "metadata",
    "source",
    "rendered",
    "versions",
    "comments",
    "publication",
  ]);
  const include = new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const item of include) {
    if (!allowed.has(item)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Unsupported include value: ${item}.`,
        400,
      );
    }
  }
  include.add("metadata");
  return include;
}

function parseLimit(value: string | null, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}
