import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  getApiRequestActor,
  jsonAppError,
  resolveWorkspaceActorPermission,
} from "../../../../lib/access";
import {
  upsertPendingGitHubConnection,
  verifyGitHubInstallationForUser,
} from "../../../../lib/github-backup";
import {
  auditService,
  ensureSeedData,
  permissionService,
  persistRuntimeState,
} from "../../../../lib/runtime";

export const prerender = false;

function redirectGeneral(url: URL, status: string) {
  return Response.redirect(
    `${url.origin}/app/settings/general?github_backup=${encodeURIComponent(status)}`,
    302,
  );
}

export const GET: APIRoute = async ({ cookies, request, url }) => {
  try {
    await ensureSeedData();
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
    permissionService.assert({
      actual: resolveWorkspaceActorPermission(actor, parsed.workspaceId),
      required: "admin",
    });
    await upsertPendingGitHubConnection({
      workspaceId: parsed.workspaceId,
      installationId,
      actorUserId: actor.user?.id ?? null,
    });
    auditService.record({
      workspaceId: parsed.workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "github_backup.connected",
      targetType: "workspace",
      targetId: parsed.workspaceId,
      metadata: { installation_id: installationId },
    });
    await persistRuntimeState();
    return redirectGeneral(url, "connected");
  } catch (error) {
    if (error instanceof AppError) {
      return redirectGeneral(url, "error");
    }
    return jsonAppError(error, "GitHub backup callback failed.");
  }
};
