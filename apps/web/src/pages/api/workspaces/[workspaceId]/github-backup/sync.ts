import type { APIRoute, AstroCookies } from "astro";
import { buildEnvelope, attachEnvelope } from "@vegastack/pages-services";
import {
  getApiRequestActor,
  jsonAppError,
  resolveWorkspaceActorPermission,
} from "../../../../../lib/access";
import { runGitHubBackupSync } from "../../../../../lib/github-backup";
import { ensureSeedData, permissionService } from "../../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../../lib/workspace-navigation";

export const prerender = false;

async function assertAdmin(
  cookies: AstroCookies,
  request: Request,
  workspaceId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
  permissionService.assert({
    actual: resolveWorkspaceActorPermission(actor, workspaceId),
    required: "admin",
  });
  return actor;
}

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertAdmin(cookies, request, workspaceId);
    const result = await runGitHubBackupSync({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
    });
    // Sync can pull in new pages from the repo, invalidating the tree.
    const treeVersion = buildWorkspaceNavigation(
      actor,
      workspaceId,
    ).treeVersion;
    return attachEnvelope(
      Response.json(result),
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`github_backup:${workspaceId}`],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "GitHub backup sync failed.");
  }
};
