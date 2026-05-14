import type { APIRoute } from "astro";
import {
  jsonAppError,
  publicationPasswordCookieName,
  publicationPasswordCookieValue,
} from "../../../../lib/access";
import {
  ensureSeedData,
  pageService,
  publicationService,
  searchIndexedPages,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, url }) => {
  try {
    await ensureSeedData();
    const publication = publicationService.get(params.publicationId ?? "");
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
    const results = await searchIndexedPages(
      publication.workspaceId,
      query,
      Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 25),
    );
    const allowedPageIds = new Set<string>();
    if (publication.resourceType === "page") {
      allowedPageIds.add(publication.resourceId);
    } else {
      const folder = workspaceService.getFolder(publication.resourceId);
      if (folder) {
        const prefix = `${folder.path}/`;
        for (const page of pageService.listPages(publication.workspaceId)) {
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
