import type { APIRoute, AstroCookies } from "astro";
import {
  getApiRequestActor,
  jsonAppError,
  resolveWorkspaceActorPermission,
} from "../../../../../lib/access";
import { runGitHubBackupSync } from "../../../../../lib/github-backup";
import { ensureSeedData, permissionService } from "../../../../../lib/runtime";

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
    return Response.json(result);
  } catch (error) {
    return jsonAppError(error, "GitHub backup sync failed.");
  }
};
