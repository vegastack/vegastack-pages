// GET /api/workspaces/:workspaceId/documents/page/:ref
//
// Returns a DocumentPayload for the page identified by :ref (slug_id or
// pg_* id). The shell controller calls this on every /p/* navigation to
// swap the document body without a full page reload. SSR routes call the
// same buildDocumentPayload() so the two paths can never drift.
//
// Auth: same access check as the SSR route — read permission required.
// Partial payloads are currently member-only: anonymous public-publication
// flows still go through the SSR /p/[slugId].astro route and do not call
// this endpoint. Activating shell navigation for public publications will
// require passing PageAccess into the builder so it can authorize the
// anonymous role.
// Cache: private, no-store. The shell stores it in sessionStorage keyed
// by workspace+user+content_hash; never edge-cached.

import type { APIRoute } from "astro";
import { jsonAppError, resolvePageAccess } from "../../../../../../lib/access";
import { buildPageDocumentPayload } from "../../../../../../lib/document-payload";
import { ensureSeedData, pageService } from "../../../../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const ref = params.ref ?? "";
    const workspaceId = params.workspaceId ?? "";
    if (!ref || !workspaceId) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Missing ref or workspaceId.",
          },
        },
        { status: 400 },
      );
    }

    // Look up the page first so we can run resolvePageAccess against it.
    // Accept slug_id or pg_* id transparently.
    const bySlug = await pageService.getPageBySlugId(ref);
    const pageWithSource = bySlug ?? (await pageService.getPage(ref));
    if (!pageWithSource || pageWithSource.page.workspaceId !== workspaceId) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }

    // Reuses the same access pipeline as SSR — guest sessions, public
    // publications, password-gated routes, and permission checks all run
    // here exactly as they do in /p/[slugId].astro.
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: pageWithSource.page,
      required: "read",
    });

    const payload = await buildPageDocumentPayload(
      ref,
      access.actor,
      workspaceId,
    );
    if (!payload) {
      return Response.json(
        { error: { code: "PAGE_NOT_FOUND", message: "Page was not found." } },
        { status: 404 },
      );
    }

    return Response.json(payload, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return jsonAppError(error, "Document payload fetch failed.");
  }
};
