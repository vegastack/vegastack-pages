import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { pages as pagesService } from "@vegastack/pages-services";
import { jsonAppError, resolvePageAccess } from "../../../../lib/access";
import { renderCachedMarkdown } from "../../../../lib/render-cache";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.pageId
      ? await pagesService.get(ctx, params.pageId)
      : null;
    if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "read",
    });
    const rendered =
      page.page.sourceType === "html"
        ? { html: "", headings: [], frontmatter: {}, frontmatterText: "" }
        : await renderCachedMarkdown({
            pageId: page.page.id,
            contentHash: page.page.contentHash,
            source: page.source,
          });
    return Response.json({
      page_id: page.page.id,
      content_hash: page.page.contentHash,
      source_type: page.page.sourceType,
      html: page.page.sourceType === "html" ? "" : rendered.html,
      render_mode: page.page.sourceType === "html" ? "sandboxed_html" : "html",
      headings: rendered.headings,
      frontmatter: rendered.frontmatter,
      frontmatter_text: rendered.frontmatterText,
    });
  } catch (error) {
    return jsonAppError(error, "Rendered page failed.");
  }
};
