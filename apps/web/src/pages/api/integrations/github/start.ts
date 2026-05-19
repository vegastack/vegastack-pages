import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { permissions } from "@vegastack/pages-services";
import {
  getApiRequestActor,
  resolveWorkspaceActorPermission,
} from "../../../../lib/access";
import { sameOrigin } from "../../../../lib/csrf";
import {
  githubAppConfigured,
  githubAppSlug,
} from "../../../../lib/github-backup";
import { serviceErrorToResponse } from "../../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!sameOrigin(request)) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Cross-site GitHub connection starts are not allowed.",
        403,
      );
    }
    if (!githubAppConfigured()) {
      throw new AppError(
        "INTERNAL_ERROR",
        "GitHub backup is not configured for this deployment.",
        500,
      );
    }
    const workspaceId = url.searchParams.get("workspace_id")?.trim() ?? "";
    if (!workspaceId) {
      throw new AppError(
        "WORKSPACE_REQUIRED",
        "workspace_id is required.",
        400,
      );
    }
    const actor = await getApiRequestActor(cookies, request);
    permissions.assertLevel({
      actual: await resolveWorkspaceActorPermission(actor, workspaceId),
      required: "admin",
    });
    const nonce = crypto.randomUUID();
    cookies.set(
      "vpg_github_install_state",
      JSON.stringify({ nonce, workspaceId }),
      {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: url.protocol === "https:",
        maxAge: 10 * 60,
      },
    );
    return Response.redirect(
      `https://github.com/apps/${encodeURIComponent(githubAppSlug())}/installations/new?state=${encodeURIComponent(nonce)}`,
      302,
    );
  } catch (error) {
    return serviceErrorToResponse(error, "GitHub backup connection failed.");
  }
};
