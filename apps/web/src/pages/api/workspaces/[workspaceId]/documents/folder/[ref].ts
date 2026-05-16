// GET /api/workspaces/:workspaceId/documents/folder/:ref
//
// Returns a DocumentPayload for the folder identified by :ref (slug_id or
// fl_* id). The shell controller calls this on every /f/* navigation to
// swap the document body without a full page reload.
//
// Auth: same access check as the SSR folder route — read permission via
// resolveFolderAccess. Bearer/MCP callers reach the actor through the
// `request` parameter (see getApiRequestActor), so the handler must
// accept it and forward it down. The page partial endpoint already does;
// the asymmetry was flagged by audit-cycle-3-findings.md F-006.
// Cache: private, no-store.

import type { APIRoute } from "astro";
import {
  jsonAppError,
  resolveFolderAccess,
} from "../../../../../../lib/access";
import { buildFolderDocumentPayload } from "../../../../../../lib/document-payload";
import {
  ensureSeedData,
  workspaceService,
} from "../../../../../../lib/runtime";

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

    const folder =
      workspaceService.getFolderBySlugId(ref) ??
      workspaceService.getFolder(ref);
    if (!folder || folder.workspaceId !== workspaceId) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
        { status: 404 },
      );
    }

    const access = await resolveFolderAccess({
      cookies,
      request,
      url,
      folder,
      required: "read",
    });

    const payload = await buildFolderDocumentPayload(
      ref,
      access.actor,
      workspaceId,
    );
    if (!payload) {
      return Response.json(
        {
          error: { code: "FOLDER_NOT_FOUND", message: "Folder was not found." },
        },
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
