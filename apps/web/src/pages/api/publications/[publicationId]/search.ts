import type { APIRoute } from "astro";
import {
  folders,
  pages as pagesService,
  publications,
  search,
} from "@vegastack/pages-services";
import {
  jsonAppError,
  publicationPasswordCookieName,
  publicationPasswordCookieValue,
} from "../../../../lib/access";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const publication = await publications.get(ctx, params.publicationId ?? "");
    if (!publication || publication.revokedAt) {
      return Response.json(
        {
          error: {
            code: "PUBLICATION_NOT_FOUND",
            message: "Publication was not found.",
          },
        },
        { status: 404 },
      );
    }
    if (
      publication.expiresAt &&
      Date.parse(publication.expiresAt) <= Date.now()
    ) {
      return Response.json(
        {
          error: {
            code: "PERMISSION_DENIED",
            message: "Publication has expired.",
          },
        },
        { status: 403 },
      );
    }
    if (publication.passwordHash) {
      const cookie =
        cookies.get(publicationPasswordCookieName(publication.id))?.value ??
        null;
      if (cookie !== (await publicationPasswordCookieValue(publication))) {
        return Response.json(
          {
            error: {
              code: "PUBLICATION_PASSWORD_REQUIRED",
              message: "This publication requires a password.",
            },
          },
          { status: 401 },
        );
      }
    }
    const query = url.searchParams.get("q") ?? "";
    const limit = Math.min(
      Number(url.searchParams.get("limit") ?? 10) || 10,
      25,
    );
    const results = await search.query(ctx, {
      workspaceId: publication.workspaceId,
      query,
      limit,
      resourceTypes: ["page"],
    });
    const allowedPageIds = new Set<string>();
    if (publication.resourceType === "page") {
      allowedPageIds.add(publication.resourceId);
    } else {
      const folder = await folders.get(ctx, publication.resourceId);
      if (folder) {
        const prefix = `${folder.path}/`;
        const workspacePages = await pagesService.list(
          ctx,
          publication.workspaceId,
        );
        for (const page of workspacePages) {
          if (
            page.folderPath === folder.path ||
            page.folderPath.startsWith(prefix)
          ) {
            allowedPageIds.add(page.id);
          }
        }
      }
    }
    return Response.json({
      results: results.filter(
        (result) => result.pageId !== null && allowedPageIds.has(result.pageId),
      ),
    });
  } catch (error) {
    return jsonAppError(error, "Publication search failed.");
  }
};
