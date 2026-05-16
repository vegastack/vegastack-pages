import { AppError } from "@vegastack/pages-core";
import type { APIRoute, AstroCookies } from "astro";
import { buildEnvelope, jsonWithEnvelope } from "@vegastack/pages-services";
import {
  getApiRequestActor,
  jsonAppError,
  resolveWorkspaceActorPermission,
} from "../../../../lib/access";
import {
  deleteGitHubBackupConnection,
  getGitHubBackupConnection,
  getLatestGitHubBackupRun,
  githubAppConfigured,
  githubAppSlug,
  githubCommitUrl,
  listInstallationRepositories,
  listRepositoryBranches,
  normalizeRootPath,
  saveGitHubBackupConnection,
  type GitHubRepository,
  type GitHubBranch,
} from "../../../../lib/github-backup";
import {
  auditService,
  ensureSeedData,
  permissionService,
  persistRuntimeState,
} from "../../../../lib/runtime";
import { buildWorkspaceNavigation } from "../../../../lib/workspace-navigation";

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

async function statusPayload(workspaceId: string, repoId?: number | null) {
  const connection = await getGitHubBackupConnection(workspaceId);
  const latestRun = await getLatestGitHubBackupRun(workspaceId);
  let repositories: GitHubRepository[] = [];
  let branches: GitHubBranch[] = [];
  if (githubAppConfigured() && connection) {
    repositories = await listInstallationRepositories(
      connection.installationId,
    );
    const selectedRepository = repoId
      ? repositories.find((repo) => repo.id === repoId)
      : null;
    if (selectedRepository) {
      branches = await listRepositoryBranches({
        installationId: connection.installationId,
        owner: selectedRepository.owner.login,
        repo: selectedRepository.name,
      });
    } else if (connection.repoOwner && connection.repoName) {
      branches = await listRepositoryBranches({
        installationId: connection.installationId,
        owner: connection.repoOwner,
        repo: connection.repoName,
      });
    }
  }
  return {
    app_configured: githubAppConfigured(),
    app_slug: githubAppSlug(),
    connection,
    latest_run: latestRun,
    repositories,
    branches,
    commit_url: githubCommitUrl(connection),
  };
}

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    await assertAdmin(cookies, request, workspaceId);
    const repoId = Number(url.searchParams.get("repo_id") ?? "");
    return Response.json(
      await statusPayload(workspaceId, Number.isFinite(repoId) ? repoId : null),
    );
  } catch (error) {
    return jsonAppError(error, "GitHub backup status failed.");
  }
};

export const PUT: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertAdmin(cookies, request, workspaceId);
    const connection = await getGitHubBackupConnection(workspaceId);
    if (!connection) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Connect GitHub before choosing a repository.",
        400,
      );
    }
    const body = await request.json();
    const repoId = Number(body.repo_id);
    const repositories = await listInstallationRepositories(
      connection.installationId,
    );
    const repository = repositories.find((repo) => repo.id === repoId);
    if (!repository) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Selected repository is not available to this GitHub App installation.",
        400,
      );
    }
    const branches = await listRepositoryBranches({
      installationId: connection.installationId,
      owner: repository.owner.login,
      repo: repository.name,
    });
    const branchName = String(body.branch || repository.default_branch);
    if (!branches.some((branch) => branch.name === branchName)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Selected branch is not available in this repository.",
        400,
      );
    }
    const saved = await saveGitHubBackupConnection({
      workspaceId,
      repoOwner: repository.owner.login,
      repoName: repository.name,
      repoId: repository.id,
      branch: branchName,
      rootPath: normalizeRootPath(body.root_path),
      includeAssets: Boolean(body.include_assets),
    });
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "github_backup.updated",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: {
        repo: repository.full_name,
        branch: branchName,
        include_assets: Boolean(body.include_assets),
      },
    });
    await persistRuntimeState();
    const treeVersion = buildWorkspaceNavigation(
      actor,
      workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { connection: saved },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [`github_backup:${workspaceId}`],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "GitHub backup update failed.");
  }
};

export const DELETE: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const actor = await assertAdmin(cookies, request, workspaceId);
    await deleteGitHubBackupConnection(workspaceId);
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "github_backup.disconnected",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: {},
    });
    await persistRuntimeState();
    const treeVersion = buildWorkspaceNavigation(
      actor,
      workspaceId,
    ).treeVersion;
    return jsonWithEnvelope(
      { ok: true },
      buildEnvelope({
        treeVersion,
        navigationInvalidated: false,
        changedResources: [`github_backup:${workspaceId}`],
      }),
    );
  } catch (error) {
    return jsonAppError(error, "GitHub backup disconnect failed.");
  }
};
