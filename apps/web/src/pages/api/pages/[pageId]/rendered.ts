import { AppError } from "@vegastack/pages-core";
import { flattenFrontmatter, renderMarkdown } from "@vegastack/pages-renderer";
import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { ensureSeedData, pageService } from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const page = params.pageId
      ? await pageService.getPage(params.pageId)
      : null;
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const rendered = await renderMarkdown(page.source);
    return Response.json({
      page_id: page.page.id,
      content_hash: page.page.contentHash,
      source_type: page.page.sourceType,
      html: page.page.sourceType === "html" ? "" : rendered.html,
      render_mode: page.page.sourceType === "html" ? "sandboxed_html" : "html",
      headings: rendered.headings,
      frontmatter: rendered.frontmatter,
      frontmatter_text: flattenFrontmatter(rendered.frontmatter),
    });
  } catch (error) {
    return jsonAppError(error, "Rendered page failed.");
  }
};
