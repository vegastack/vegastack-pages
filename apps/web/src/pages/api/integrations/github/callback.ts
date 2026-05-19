import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { audit, permissions } from "@vegastack/pages-services";
import {
  getApiRequestActor,
  resolveWorkspaceActorPermission,
} from "../../../../lib/access";
import {
  upsertPendingGitHubConnection,
  verifyGitHubInstallationForUser,
} from "../../../../lib/github-backup";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

function redirectGeneral(url: URL, status: string) {
  return Response.redirect(
    `${url.origin}/app/settings/general?github_backup=${encodeURIComponent(status)}`,
    302,
  );
}

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    const rawState = cookies.get("vpg_github_install_state")?.value ?? "";
    cookies.delete("vpg_github_install_state", { path: "/" });
    const parsed = rawState
      ? (JSON.parse(rawState) as { nonce?: string; workspaceId?: string })
      : {};
    const state = url.searchParams.get("state") ?? "";
    if (!parsed.nonce || parsed.nonce !== state || !parsed.workspaceId) {
      throw new AppError(
        "VALIDATION_ERROR",
        "GitHub install state could not be verified.",
        400,
      );
    }
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!Number.isFinite(installationId) || installationId <= 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "GitHub did not return an installation id.",
        400,
      );
    }
    await verifyGitHubInstallationForUser({
      code: url.searchParams.get("code") ?? "",
      installationId,
      redirectUri: `${url.origin}/api/integrations/github/callback`,
    });
    const actor = await getApiRequestActor(cookies, request);
    const { ctx } = await buildServiceContext({
      cookies,
      request,
      workspaceId: parsed.workspaceId,
    });
    permissions.assertLevel({
      actual: await resolveWorkspaceActorPermission(actor, parsed.workspaceId),
      required: "admin",
    });
    await upsertPendingGitHubConnection(ctx, {
      workspaceId: parsed.workspaceId,
      installationId,
      actorUserId: actor.user?.id ?? null,
    });
    await audit.record(ctx, {
      workspaceId: parsed.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "github_backup.connected",
      targetType: "workspace",
      targetId: parsed.workspaceId,
      metadata: { installation_id: installationId },
    });
    return redirectGeneral(url, "connected");
  } catch (error) {
    if (error instanceof AppError) {
      return redirectGeneral(url, "error");
    }
    return serviceErrorToResponse(error, "GitHub backup callback failed.");
  }
};
