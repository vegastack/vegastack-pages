import type { APIRoute, AstroCookies } from "astro";
import {
  buildEnvelope,
  jsonWithEnvelope,
  permissions,
} from "@vegastack/pages-services";
import {
  getApiRequestActor,
  resolveWorkspaceActorPermission,
} from "../../../../../lib/access";
import { runGitHubBackupSync } from "../../../../../lib/github-backup";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../../lib/service-context";
import { buildWorkspaceNavigation } from "../../../../../lib/workspace-navigation";

export const prerender = false;

async function assertAdmin(
  cookies: AstroCookies,
  request: Request,
  workspaceId: string,
) {
  const actor = await getApiRequestActor(cookies, request);
  const { ctx } = await buildServiceContext({ cookies, request, workspaceId });
  permissions.assertLevel({
    actual: await resolveWorkspaceActorPermission(actor, workspaceId),
    required: "admin",
  });
  return { actor, ctx };
}

export const POST: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId ?? "";
    const { actor, ctx } = await assertAdmin(cookies, request, workspaceId);
    const result = await runGitHubBackupSync(ctx, {
      workspaceId,
      actorUserId: actor.user?.id ?? null,
    });
    // Sync can pull in new pages from the repo, invalidating the tree.
    const treeVersion = (await buildWorkspaceNavigation(actor, workspaceId))
      .treeVersion;
    return jsonWithEnvelope(
      result as Record<string, unknown>,
      buildEnvelope({
        treeVersion,
        navigationInvalidated: true,
        changedResources: [`github_backup:${workspaceId}`],
      }),
    );
  } catch (error) {
    return serviceErrorToResponse(error, "GitHub backup sync failed.");
  }
};
