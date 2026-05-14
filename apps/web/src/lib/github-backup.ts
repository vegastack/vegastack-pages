import { AppError } from "@vegastack/pages-core";
import {
  attachmentService,
  auditService,
  d1All,
  d1Batch,
  d1Run,
  acquireRuntimeMutationLock,
  ensureRuntimeReady,
  pageService,
  persistRuntimeState,
  templateService,
  workspaceService,
} from "./runtime";

export type GitHubBackupConnection = {
  id: string;
  workspaceId: string;
  installationId: number;
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  branch: string | null;
  rootPath: string;
  includeAssets: boolean;
  enabled: boolean;
  lastStatus: "pending" | "success" | "failed" | "idle";
  lastSyncedAt: string | null;
  lastCommitSha: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubBackupRun = {
  id: string;
  connectionId: string;
  workspaceId: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  baseCommitSha: string | null;
  headCommitSha: string | null;
  pagesWritten: number;
  templatesWritten: number;
  assetsWritten: number;
  filesDeleted: number;
  errorJson: string | null;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  html_url: string;
  private: boolean;
};

export type GitHubBranch = {
  name: string;
  commit: { sha: string };
};

type GitHubUserInstallation = {
  id: number;
  app_id: number;
  account?: { login?: string };
};

type GitHubTreeObject = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

type PlannedFile = {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  kind: "page" | "template" | "asset" | "metadata";
};

type BackupManifest = {
  version: 1;
  workspace_id: string;
  workspace_slug: string;
  root_path: string;
  include_assets: boolean;
  synced_at: string;
  owned_files: string[];
  pages: Array<{
    id: string;
    title: string;
    path: string;
    slug_id: string;
    version_id: string;
    content_hash: string;
  }>;
  templates: Array<{
    id: string;
    name: string;
    slug: string;
    path: string;
    version_id: string;
    content_hash: string;
  }>;
  assets: Array<{
    id: string;
    page_id: string;
    filename: string;
    path: string;
    content_type: string;
    byte_size: number;
  }>;
};

const githubApiBase = "https://api.github.com";
const maxMirroredAssetBytes = 10 * 1024 * 1024;
const maxPreviousManifestBytes = 1024 * 1024;

function boolFromDb(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function jsonPretty(input: unknown) {
  return `${JSON.stringify(input, null, 2)}\n`;
}

function extension(sourceType: string) {
  return sourceType === "mdx" ? "mdx" : sourceType === "html" ? "html" : "md";
}

function safeSegment(input: string, fallback: string) {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

function validateRepoPath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "GitHub backup path is unsafe.",
      400,
    );
  }
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.some((part) => part.toLowerCase() === ".github")
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "GitHub backup path is unsafe.",
      400,
    );
  }
}

export function normalizeRootPath(input: unknown) {
  const root = String(input ?? "docs")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  validateRepoPath(root || "docs");
  return root || "docs";
}

function joinPath(...parts: Array<string | null | undefined>) {
  const path = parts
    .filter((part): part is string => Boolean(part))
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  validateRepoPath(path);
  return path;
}

function connectionFromRow(
  row: Record<string, unknown>,
): GitHubBackupConnection {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    installationId: Number(row.installationId),
    repoOwner: row.repoOwner ? String(row.repoOwner) : null,
    repoName: row.repoName ? String(row.repoName) : null,
    repoId: numberOrNull(row.repoId),
    branch: row.branch ? String(row.branch) : null,
    rootPath: String(row.rootPath ?? "docs"),
    includeAssets: boolFromDb(row.includeAssets),
    enabled: boolFromDb(row.enabled),
    lastStatus: String(
      row.lastStatus ?? "idle",
    ) as GitHubBackupConnection["lastStatus"],
    lastSyncedAt: row.lastSyncedAt ? String(row.lastSyncedAt) : null,
    lastCommitSha: row.lastCommitSha ? String(row.lastCommitSha) : null,
    lastError: row.lastError ? String(row.lastError) : null,
    createdBy: row.createdBy ? String(row.createdBy) : null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function runFromRow(row: Record<string, unknown>): GitHubBackupRun {
  return {
    id: String(row.id),
    connectionId: String(row.connectionId),
    workspaceId: String(row.workspaceId),
    status: String(row.status) as GitHubBackupRun["status"],
    startedAt: String(row.startedAt),
    finishedAt: row.finishedAt ? String(row.finishedAt) : null,
    baseCommitSha: row.baseCommitSha ? String(row.baseCommitSha) : null,
    headCommitSha: row.headCommitSha ? String(row.headCommitSha) : null,
    pagesWritten: Number(row.pagesWritten ?? 0),
    templatesWritten: Number(row.templatesWritten ?? 0),
    assetsWritten: Number(row.assetsWritten ?? 0),
    filesDeleted: Number(row.filesDeleted ?? 0),
    errorJson: row.errorJson ? String(row.errorJson) : null,
  };
}

export function githubAppConfigured() {
  return Boolean(
    process.env.VPG_GITHUB_APP_ID &&
    process.env.VPG_GITHUB_APP_SLUG &&
    process.env.VPG_GITHUB_APP_PRIVATE_KEY &&
    process.env.VPG_GITHUB_APP_CLIENT_ID &&
    process.env.VPG_GITHUB_APP_CLIENT_SECRET,
  );
}

export function githubAppSlug() {
  return process.env.VPG_GITHUB_APP_SLUG ?? "";
}

function requireGithubAppConfig() {
  if (!githubAppConfigured()) {
    throw new AppError(
      "INTERNAL_ERROR",
      "GitHub backup is not configured for this deployment.",
      500,
    );
  }
  return {
    appId: String(process.env.VPG_GITHUB_APP_ID),
    slug: String(process.env.VPG_GITHUB_APP_SLUG),
    clientId: String(process.env.VPG_GITHUB_APP_CLIENT_ID),
    clientSecret: String(process.env.VPG_GITHUB_APP_CLIENT_SECRET),
    privateKey: String(process.env.VPG_GITHUB_APP_PRIVATE_KEY).replaceAll(
      "\\n",
      "\n",
    ),
  };
}

function base64Url(input: ArrayBuffer | Uint8Array | string) {
  let binary = "";
  if (typeof input === "string") {
    binary = btoa(input);
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (const byte of bytes) binary += String.fromCharCode(byte);
    binary = btoa(binary);
  }
  return binary.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function plannedFileBytes(file: PlannedFile) {
  if (file.encoding === "utf-8") return new TextEncoder().encode(file.content);
  const binary = atob(file.content.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function gitBlobSha(file: PlannedFile) {
  const bytes = plannedFileBytes(file);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function pemToBytes(pem: string) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

function derLength(length: number) {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derSequence(...parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const header = Uint8Array.of(0x30, ...derLength(length));
  const out = new Uint8Array(header.length + length);
  out.set(header);
  let offset = header.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derInteger(value: number) {
  return Uint8Array.of(0x02, 0x01, value);
}

function derOctetString(value: Uint8Array) {
  const header = Uint8Array.of(0x04, ...derLength(value.length));
  const out = new Uint8Array(header.length + value.length);
  out.set(header);
  out.set(value, header.length);
  return out;
}

function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const rsaEncryptionOid = Uint8Array.of(
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
  );
  const nullParam = Uint8Array.of(0x05, 0x00);
  return derSequence(
    derInteger(0),
    derSequence(rsaEncryptionOid, nullParam),
    derOctetString(pkcs1),
  );
}

async function githubAppJwt() {
  const { appId, privateKey } = requireGithubAppConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const pkcs8 = privateKey.includes("BEGIN RSA PRIVATE KEY")
    ? pkcs1ToPkcs8(pemToBytes(privateKey))
    : pemToBytes(privateKey);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

async function githubFetch<T>(
  path: string,
  options: {
    method?: string;
    token: string;
    body?: unknown;
    raw?: boolean;
  },
): Promise<T> {
  const response = await fetch(`${githubApiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: options.raw
        ? "application/vnd.github.raw"
        : "application/vnd.github+json",
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
      "user-agent": "vegastack-pages",
      "x-github-api-version": "2022-11-28",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      "INTERNAL_ERROR",
      `GitHub API request failed: ${response.status}`,
      response.status >= 500 ? 502 : 400,
      { status: response.status, path, body: text.slice(0, 1000) },
    );
  }
  if (options.raw) return (await response.text()) as T;
  return (await response.json()) as T;
}

async function githubOAuthAccessToken(code: string, redirectUri?: string) {
  const { clientId, clientSecret } = requireGithubAppConfig();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "vegastack-pages",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !payload?.access_token || payload.error) {
    throw new AppError(
      "PERMISSION_DENIED",
      payload?.error_description ||
        payload?.error ||
        "GitHub installation authorization failed.",
      response.ok ? 403 : response.status >= 500 ? 502 : 403,
    );
  }
  return payload.access_token;
}

async function githubFetchPaginated<T>(
  path: string,
  options: { token: string; extract?: (payload: unknown) => T[] },
) {
  const results: T[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await githubFetch<unknown>(
      `${path}${separator}per_page=100&page=${page}`,
      { token: options.token },
    );
    const items = options.extract
      ? options.extract(payload)
      : Array.isArray(payload)
        ? (payload as T[])
        : [];
    results.push(...items);
    const totalCount =
      payload &&
      typeof payload === "object" &&
      "total_count" in payload &&
      typeof (payload as { total_count?: unknown }).total_count === "number"
        ? (payload as { total_count: number }).total_count
        : null;
    if (
      items.length < 100 ||
      (totalCount !== null && results.length >= totalCount)
    ) {
      break;
    }
  }
  return results;
}

async function installationToken(installationId: number) {
  const jwt = await githubAppJwt();
  const response = await githubFetch<{ token: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: jwt },
  );
  return response.token;
}

export async function verifyGitHubInstallationForUser(input: {
  code: string;
  installationId: number;
  redirectUri?: string;
}) {
  const code = input.code.trim();
  if (!code) {
    throw new AppError(
      "VALIDATION_ERROR",
      "GitHub did not return an authorization code.",
      400,
    );
  }
  const { appId } = requireGithubAppConfig();
  const token = await githubOAuthAccessToken(code, input.redirectUri);
  const installations = await githubFetchPaginated<GitHubUserInstallation>(
    "/user/installations",
    {
      token,
      extract: (payload) => {
        if (!payload || typeof payload !== "object") return [];
        const installations = (payload as { installations?: unknown })
          .installations;
        return Array.isArray(installations)
          ? (installations as GitHubUserInstallation[])
          : [];
      },
    },
  );
  const verified = installations.find(
    (installation) =>
      installation.id === input.installationId &&
      String(installation.app_id) === appId,
  );
  if (!verified) {
    throw new AppError(
      "PERMISSION_DENIED",
      "GitHub installation could not be verified for this user.",
      403,
    );
  }
  return verified;
}

export async function listInstallationRepositories(installationId: number) {
  const token = await installationToken(installationId);
  const repos = await githubFetchPaginated<GitHubRepository>(
    "/installation/repositories",
    {
      token,
      extract: (payload) => {
        if (!payload || typeof payload !== "object") return [];
        const repositories = (payload as { repositories?: unknown })
          .repositories;
        return Array.isArray(repositories)
          ? (repositories as GitHubRepository[])
          : [];
      },
    },
  );
  return repos.sort((left, right) =>
    left.full_name.localeCompare(right.full_name),
  );
}

export async function listRepositoryBranches(input: {
  installationId: number;
  owner: string;
  repo: string;
}) {
  const token = await installationToken(input.installationId);
  return githubFetchPaginated<GitHubBranch>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches`,
    { token },
  );
}

export async function getGitHubBackupConnection(workspaceId: string) {
  await ensureRuntimeReady();
  const rows = await d1All<Record<string, unknown>>(
    "SELECT id, workspace_id as workspaceId, installation_id as installationId, repo_owner as repoOwner, repo_name as repoName, repo_id as repoId, branch, root_path as rootPath, include_assets as includeAssets, enabled, last_status as lastStatus, last_synced_at as lastSyncedAt, last_commit_sha as lastCommitSha, last_error as lastError, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM github_sync_connections WHERE workspace_id = ?",
    workspaceId,
  );
  return rows[0] ? connectionFromRow(rows[0]) : null;
}

export async function getLatestGitHubBackupRun(workspaceId: string) {
  await ensureRuntimeReady();
  const rows = await d1All<Record<string, unknown>>(
    "SELECT id, connection_id as connectionId, workspace_id as workspaceId, status, started_at as startedAt, finished_at as finishedAt, base_commit_sha as baseCommitSha, head_commit_sha as headCommitSha, pages_written as pagesWritten, templates_written as templatesWritten, assets_written as assetsWritten, files_deleted as filesDeleted, error_json as errorJson FROM github_sync_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1",
    workspaceId,
  );
  return rows[0] ? runFromRow(rows[0]) : null;
}

export async function upsertPendingGitHubConnection(input: {
  workspaceId: string;
  installationId: number;
  actorUserId: string | null;
}) {
  await ensureRuntimeReady();
  const now = new Date().toISOString();
  const existing = await getGitHubBackupConnection(input.workspaceId);
  if (existing) {
    await d1Run(
      "UPDATE github_sync_connections SET installation_id = ?, enabled = 0, last_status = 'idle', last_error = NULL, updated_at = ? WHERE workspace_id = ?",
      input.installationId,
      now,
      input.workspaceId,
    );
  } else {
    await d1Run(
      "INSERT INTO github_sync_connections (id, workspace_id, installation_id, root_path, include_assets, enabled, last_status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'docs', 0, 0, 'idle', ?, ?, ?)",
      randomId("ghc"),
      input.workspaceId,
      input.installationId,
      input.actorUserId,
      now,
      now,
    );
  }
  return getGitHubBackupConnection(input.workspaceId);
}

export async function saveGitHubBackupConnection(input: {
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  repoId: number;
  branch: string;
  rootPath: string;
  includeAssets: boolean;
}) {
  await ensureRuntimeReady();
  const existing = await getGitHubBackupConnection(input.workspaceId);
  if (!existing) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Connect GitHub before choosing a repository.",
      400,
    );
  }
  const rootPath = normalizeRootPath(input.rootPath);
  const now = new Date().toISOString();
  await d1Run(
    "UPDATE github_sync_connections SET repo_owner = ?, repo_name = ?, repo_id = ?, branch = ?, root_path = ?, include_assets = ?, enabled = 1, last_status = 'idle', last_error = NULL, updated_at = ? WHERE workspace_id = ?",
    input.repoOwner,
    input.repoName,
    input.repoId,
    input.branch,
    rootPath,
    input.includeAssets ? 1 : 0,
    now,
    input.workspaceId,
  );
  return getGitHubBackupConnection(input.workspaceId);
}

export async function deleteGitHubBackupConnection(workspaceId: string) {
  await ensureRuntimeReady();
  await d1Run(
    "DELETE FROM github_sync_connections WHERE workspace_id = ?",
    workspaceId,
  );
}

function buildPagePath(input: {
  rootPath: string;
  folderPath: string;
  slug: string;
  slugId: string;
  sourceType: string;
  used: Set<string>;
}) {
  const folder = input.folderPath
    .split("/")
    .filter(Boolean)
    .map((part, index) => safeSegment(part, `folder-${index + 1}`))
    .join("/");
  const ext = extension(input.sourceType);
  const baseName = `${safeSegment(input.slug, "page")}.${ext}`;
  let path = joinPath(input.rootPath, folder, baseName);
  if (input.used.has(path)) {
    const shortId = input.slugId.slice(input.slugId.lastIndexOf("-") + 1);
    path = joinPath(
      input.rootPath,
      folder,
      `${safeSegment(input.slug, "page")}-${shortId}.${ext}`,
    );
  }
  let suffix = 2;
  while (input.used.has(path)) {
    path = joinPath(
      input.rootPath,
      folder,
      `${safeSegment(input.slug, "page")}-${input.slugId}-${suffix}.${ext}`,
    );
    suffix += 1;
  }
  input.used.add(path);
  return path;
}

function parsePreviousManifest(raw: string | null): BackupManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BackupManifest;
    return parsed?.version === 1 && Array.isArray(parsed.owned_files)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function planGitHubBackupDeletes(input: {
  previousManifest: { owned_files?: unknown; root_path?: unknown } | null;
  desiredPaths: Set<string>;
}) {
  const owned = Array.isArray(input.previousManifest?.owned_files)
    ? input.previousManifest.owned_files
    : [];
  const previousRoot =
    typeof input.previousManifest?.root_path === "string"
      ? normalizeRootPath(input.previousManifest.root_path)
      : "docs";
  return owned
    .filter((path): path is string => typeof path === "string")
    .filter((path) => {
      validateRepoPath(path);
      if (
        path !== ".vegastack-pages/manifest.json" &&
        !path.startsWith(".vegastack-pages/") &&
        path !== previousRoot &&
        !path.startsWith(`${previousRoot}/`)
      ) {
        return false;
      }
      return !input.desiredPaths.has(path);
    });
}

export async function buildGitHubBackupFiles(
  connection: GitHubBackupConnection,
  now = new Date(),
): Promise<{ files: PlannedFile[]; manifest: BackupManifest }> {
  const workspace = workspaceService.getWorkspace(connection.workspaceId);
  if (!workspace) {
    throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.", 404);
  }

  const used = new Set<string>();
  const files: PlannedFile[] = [];
  const pages: BackupManifest["pages"] = [];
  const templates: BackupManifest["templates"] = [];
  const assets: BackupManifest["assets"] = [];

  for (const page of pageService.listPages(workspace.id)) {
    const withSource = await pageService.getPage(page.id);
    if (!withSource) continue;
    const path = buildPagePath({
      rootPath: connection.rootPath,
      folderPath: page.folderPath,
      slug: page.slug,
      slugId: page.slugId,
      sourceType: page.sourceType,
      used,
    });
    files.push({
      path,
      content: withSource.source,
      encoding: "utf-8",
      kind: "page",
    });
    pages.push({
      id: page.id,
      title: page.title,
      path,
      slug_id: page.slugId,
      version_id: page.versionId,
      content_hash: page.contentHash,
    });

    if (connection.includeAssets) {
      for (const attachment of attachmentService.listForPage(page.id)) {
        if (attachment.byteSize > maxMirroredAssetBytes) continue;
        const stored = await attachmentService.get(attachment.id);
        if (!stored) continue;
        const assetPath = joinPath(
          connection.rootPath,
          "assets",
          safeSegment(page.slugId, page.id),
          attachment.id,
          safeSegment(attachment.filename, attachment.id),
        );
        files.push({
          path: assetPath,
          content: stored.base64Body,
          encoding: "base64",
          kind: "asset",
        });
        assets.push({
          id: attachment.id,
          page_id: page.id,
          filename: attachment.filename,
          path: assetPath,
          content_type: attachment.contentType,
          byte_size: attachment.byteSize,
        });
      }
    }
  }

  for (const template of templateService.listTemplates(workspace.id)) {
    const withSource = await templateService.getTemplateWithSource(template.id);
    if (!withSource) continue;
    const templatePath = joinPath(
      ".vegastack-pages",
      "templates",
      safeSegment(template.category, "general"),
      `${safeSegment(template.slug, template.id)}.${extension(template.sourceType)}`,
    );
    files.push({
      path: templatePath,
      content: withSource.source,
      encoding: "utf-8",
      kind: "template",
    });
    templates.push({
      id: template.id,
      name: template.name,
      slug: template.slug,
      path: templatePath,
      version_id: template.versionId,
      content_hash: template.contentHash,
    });
  }

  const syncedAt = now.toISOString();
  const manifest: BackupManifest = {
    version: 1,
    workspace_id: workspace.id,
    workspace_slug: workspace.slug,
    root_path: connection.rootPath,
    include_assets: connection.includeAssets,
    synced_at: syncedAt,
    owned_files: [],
    pages,
    templates,
    assets,
  };
  const folders = workspaceService.listFolders(workspace.id);
  const metadata = [
    ["manifest.json", manifest],
    ["workspace.json", { workspace, synced_at: syncedAt }],
    ["pages.json", { pages, synced_at: syncedAt }],
    ["folders.json", { folders, synced_at: syncedAt }],
    ["templates.json", { templates, synced_at: syncedAt }],
    ["assets.json", { assets, synced_at: syncedAt }],
  ] as const;
  for (const [filename, content] of metadata) {
    files.push({
      path: joinPath(".vegastack-pages", filename),
      content: jsonPretty(content),
      encoding: "utf-8",
      kind: "metadata",
    });
  }
  manifest.owned_files = files.map((file) => file.path).sort();
  files[
    files.findIndex((file) => file.path === ".vegastack-pages/manifest.json")
  ] = {
    path: ".vegastack-pages/manifest.json",
    content: jsonPretty(manifest),
    encoding: "utf-8",
    kind: "metadata",
  };
  return { files, manifest };
}

function validateConnectionReady(connection: GitHubBackupConnection) {
  if (
    !connection.repoOwner ||
    !connection.repoName ||
    !connection.repoId ||
    !connection.branch
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose a GitHub repository before syncing.",
      400,
    );
  }
}

class GitHubGitClient {
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private path(path: string) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
  }

  private branchRef(branch: string) {
    return branch.split("/").map(encodeURIComponent).join("/");
  }

  async ref(branch: string) {
    return githubFetch<{
      object: { sha: string };
    }>(this.path(`/git/ref/heads/${this.branchRef(branch)}`), {
      token: this.token,
    });
  }

  async commit(sha: string) {
    return githubFetch<{ sha: string; tree: { sha: string } }>(
      this.path(`/git/commits/${sha}`),
      { token: this.token },
    );
  }

  async tree(sha: string) {
    return githubFetch<{ tree: GitHubTreeObject[] }>(
      this.path(`/git/trees/${sha}?recursive=1`),
      { token: this.token },
    );
  }

  async blob(sha: string) {
    const response = await githubFetch<{ content: string; encoding: string }>(
      this.path(`/git/blobs/${sha}`),
      { token: this.token },
    );
    if (response.encoding !== "base64") return null;
    return atob(response.content.replace(/\s+/g, ""));
  }

  async createBlob(file: PlannedFile) {
    return githubFetch<{ sha: string }>(this.path("/git/blobs"), {
      method: "POST",
      token: this.token,
      body: { content: file.content, encoding: file.encoding },
    });
  }

  async createTree(input: {
    baseTreeSha: string;
    tree: Array<{
      path: string;
      mode: "100644";
      type: "blob";
      sha: string | null;
    }>;
  }) {
    return githubFetch<{ sha: string }>(this.path("/git/trees"), {
      method: "POST",
      token: this.token,
      body: { base_tree: input.baseTreeSha, tree: input.tree },
    });
  }

  async createCommit(input: {
    message: string;
    treeSha: string;
    parentSha: string;
  }) {
    return githubFetch<{ sha: string }>(this.path("/git/commits"), {
      method: "POST",
      token: this.token,
      body: {
        message: input.message,
        tree: input.treeSha,
        parents: [input.parentSha],
      },
    });
  }

  async updateRef(branch: string, sha: string) {
    return githubFetch<{ object: { sha: string } }>(
      this.path(`/git/refs/heads/${this.branchRef(branch)}`),
      {
        method: "PATCH",
        token: this.token,
        body: { sha, force: false },
      },
    );
  }
}

async function createRun(connection: GitHubBackupConnection) {
  const id = randomId("ghr");
  await d1Run(
    "INSERT INTO github_sync_runs (id, connection_id, workspace_id, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    id,
    connection.id,
    connection.workspaceId,
    new Date().toISOString(),
  );
  return id;
}

async function finishRun(
  runId: string,
  connection: GitHubBackupConnection,
  input: {
    status: "success" | "failed";
    baseCommitSha?: string | null;
    headCommitSha?: string | null;
    pagesWritten?: number;
    templatesWritten?: number;
    assetsWritten?: number;
    filesDeleted?: number;
    error?: unknown;
  },
) {
  const now = new Date().toISOString();
  const errorJson = input.error
    ? JSON.stringify({
        message:
          input.error instanceof Error
            ? input.error.message
            : "GitHub backup sync failed.",
        details:
          input.error instanceof AppError ? input.error.details : undefined,
      })
    : null;
  await d1Batch(async () => {
    await d1Run(
      "UPDATE github_sync_runs SET status = ?, finished_at = ?, base_commit_sha = ?, head_commit_sha = ?, pages_written = ?, templates_written = ?, assets_written = ?, files_deleted = ?, error_json = ? WHERE id = ?",
      input.status,
      now,
      input.baseCommitSha ?? null,
      input.headCommitSha ?? null,
      input.pagesWritten ?? 0,
      input.templatesWritten ?? 0,
      input.assetsWritten ?? 0,
      input.filesDeleted ?? 0,
      errorJson,
      runId,
    );
    await d1Run(
      "UPDATE github_sync_connections SET last_status = ?, last_synced_at = ?, last_commit_sha = ?, last_error = ?, updated_at = ? WHERE id = ?",
      input.status,
      input.status === "success" ? now : connection.lastSyncedAt,
      input.headCommitSha ?? connection.lastCommitSha,
      errorJson,
      now,
      connection.id,
    );
  });
}

async function syncOnce(connection: GitHubBackupConnection) {
  validateConnectionReady(connection);
  const token = await installationToken(connection.installationId);
  const client = new GitHubGitClient(
    token,
    connection.repoOwner!,
    connection.repoName!,
  );
  const ref = await client.ref(connection.branch!);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await client.commit(baseCommitSha);
  const tree = await client.tree(baseCommit.tree.sha);
  const existing = new Map(
    tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => [item.path, item]),
  );
  const manifestEntry = existing.get(".vegastack-pages/manifest.json");
  const previousManifest =
    manifestEntry &&
    Number(manifestEntry.size ?? 0) > 0 &&
    Number(manifestEntry.size ?? 0) <= maxPreviousManifestBytes
      ? parsePreviousManifest(await client.blob(manifestEntry.sha))
      : null;
  const built = await buildGitHubBackupFiles(connection);
  const trustedPreviousManifest =
    previousManifest?.workspace_id === connection.workspaceId
      ? previousManifest
      : null;
  const desiredPaths = new Set(built.files.map((file) => file.path));
  const ownedDeletes = planGitHubBackupDeletes({
    previousManifest: trustedPreviousManifest,
    desiredPaths,
  });
  const nextTree: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = [];
  let pagesWritten = 0;
  let templatesWritten = 0;
  let assetsWritten = 0;
  for (const file of built.files) {
    if (existing.get(file.path)?.sha === (await gitBlobSha(file))) continue;
    const blob = await client.createBlob(file);
    nextTree.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
    if (file.kind === "page") pagesWritten += 1;
    if (file.kind === "template") templatesWritten += 1;
    if (file.kind === "asset") assetsWritten += 1;
  }
  let filesDeleted = 0;
  for (const path of ownedDeletes) {
    if (!existing.has(path)) continue;
    filesDeleted += 1;
    nextTree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  if (nextTree.length === 0) {
    return {
      baseCommitSha,
      headCommitSha: baseCommitSha,
      pagesWritten: 0,
      templatesWritten: 0,
      assetsWritten: 0,
      filesDeleted: 0,
    };
  }
  const newTree = await client.createTree({
    baseTreeSha: baseCommit.tree.sha,
    tree: nextTree,
  });
  const workspace = workspaceService.getWorkspace(connection.workspaceId);
  const commit = await client.createCommit({
    treeSha: newTree.sha,
    parentSha: baseCommitSha,
    message: [
      `Sync VegaStack Pages workspace: ${workspace?.name ?? connection.workspaceId}`,
      "",
      `Workspace: ${connection.workspaceId}`,
      `Pages: ${built.manifest.pages.length}`,
      `Templates: ${built.manifest.templates.length}`,
      `Assets: ${built.manifest.assets.length}`,
      `Synced-at: ${built.manifest.synced_at}`,
    ].join("\n"),
  });
  await client.updateRef(connection.branch!, commit.sha);
  return {
    baseCommitSha,
    headCommitSha: commit.sha,
    pagesWritten,
    templatesWritten,
    assetsWritten,
    filesDeleted,
  };
}

export async function runGitHubBackupSync(input: {
  workspaceId: string;
  actorUserId?: string | null;
}) {
  await ensureRuntimeReady();
  const connection = await getGitHubBackupConnection(input.workspaceId);
  if (!connection) {
    throw new AppError(
      "VALIDATION_ERROR",
      "GitHub backup is not connected.",
      404,
    );
  }
  const runId = await createRun(connection);
  auditService.record({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId ?? null,
    action: "github_backup.sync_started",
    targetType: "workspace",
    targetId: input.workspaceId,
    metadata: { connection_id: connection.id },
  });
  await persistRuntimeState();
  try {
    let result;
    try {
      result = await syncOnce(connection);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.details &&
        Number((error.details as { status?: number }).status) === 422
      ) {
        result = await syncOnce(connection);
      } else {
        throw error;
      }
    }
    await finishRun(runId, connection, { status: "success", ...result });
    auditService.record({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      action: "github_backup.sync_succeeded",
      targetType: "workspace",
      targetId: input.workspaceId,
      metadata: {
        connection_id: connection.id,
        commit_sha: result.headCommitSha,
      },
    });
    await persistRuntimeState();
  } catch (error) {
    await finishRun(runId, connection, { status: "failed", error });
    auditService.record({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      action: "github_backup.sync_failed",
      targetType: "workspace",
      targetId: input.workspaceId,
      metadata: {
        connection_id: connection.id,
        message:
          error instanceof Error ? error.message : "GitHub backup sync failed.",
      },
    });
    await persistRuntimeState();
    throw error;
  }
  const [run, updated] = await Promise.all([
    getLatestGitHubBackupRun(input.workspaceId),
    getGitHubBackupConnection(input.workspaceId),
  ]);
  return { run, connection: updated };
}

export async function runDueGitHubBackupSyncs() {
  await ensureRuntimeReady();
  if (!githubAppConfigured()) return { synced: 0, failed: 0 };
  const rows = await d1All<Record<string, unknown>>(
    "SELECT id, workspace_id as workspaceId, installation_id as installationId, repo_owner as repoOwner, repo_name as repoName, repo_id as repoId, branch, root_path as rootPath, include_assets as includeAssets, enabled, last_status as lastStatus, last_synced_at as lastSyncedAt, last_commit_sha as lastCommitSha, last_error as lastError, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM github_sync_connections WHERE enabled = 1 AND repo_owner IS NOT NULL AND repo_name IS NOT NULL AND branch IS NOT NULL ORDER BY updated_at",
  );
  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    const connection = connectionFromRow(row);
    let lock: { release(): Promise<void> } | null = null;
    try {
      lock = await acquireRuntimeMutationLock({
        timeoutMs: 5_000,
        ttlMs: 15 * 60_000,
      });
      await runGitHubBackupSync({ workspaceId: connection.workspaceId });
      synced += 1;
    } catch (error) {
      console.error("GitHub backup scheduled sync failed", error);
      failed += 1;
    } finally {
      await lock?.release();
    }
  }
  return { synced, failed };
}

export function githubCommitUrl(connection: GitHubBackupConnection | null) {
  if (
    !connection?.repoOwner ||
    !connection.repoName ||
    !connection.lastCommitSha
  ) {
    return null;
  }
  return `https://github.com/${connection.repoOwner}/${connection.repoName}/commit/${connection.lastCommitSha}`;
}
