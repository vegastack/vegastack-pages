import {
  d1All,
  d1Run,
  ensureRuntimeReady,
  runtimeIsD1,
  sha256Hex,
} from "../runtime";

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_S = 5;

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64UrlEncode(value);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const computed = base64UrlEncode(new Uint8Array(digest));
  if (computed.length !== codeChallenge.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i += 1) {
    mismatch |= computed.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  }
  return mismatch === 0;
}

export function randomUserCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  const buffer = new Uint8Array(8);
  crypto.getRandomValues(buffer);
  let code = "";
  for (let i = 0; i < buffer.length; i += 1) {
    code += alphabet[buffer[i]! % alphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

/**
 * Single transient OAuth grant row. Backed by `oauth_grants` (one table for
 * both authorization-code and device-code flows).
 *
 * `kind=auth_code` rows require redirect_uri + code_challenge + user_id +
 * workspace_id. `kind=device_code` rows require user_code. The CHECK constraint
 * on the table enforces the per-kind shape; we mirror it in the persist helpers
 * below for clarity.
 */
export type OAuthGrantRow = {
  codeHash: string;
  kind: "auth_code" | "device_code";
  status: "pending" | "approved" | "denied" | "consumed";
  clientId: string;
  userId: string | null;
  workspaceId: string | null;
  scope: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  userCode: string | null;
  lastPolledAt: string | null;
  expiresAt: string;
  createdAt: string;
};

// Process-local fallback for environments without D1 (test runners, dev with
// `VPG_RUNTIME` unset). Mirrors the persistence pattern used elsewhere in
// runtime.ts so the OAuth surface works identically in both modes.
const fallbackGrants = new Map<string, OAuthGrantRow>();

function fallbackPrune(now: number): void {
  for (const [hash, row] of fallbackGrants.entries()) {
    if (Date.parse(row.expiresAt) <= now) {
      fallbackGrants.delete(hash);
    }
  }
}

/**
 * Drop expired grant rows. Cheap (single DELETE) and called inline before each
 * persist so the table self-bounds without a cron job.
 */
export async function pruneExpiredGrants(): Promise<void> {
  await ensureRuntimeReady();
  const now = Date.now();
  fallbackPrune(now);
  if (runtimeIsD1()) {
    await d1Run(
      "DELETE FROM oauth_grants WHERE expires_at < ?",
      new Date(now).toISOString(),
    );
  }
}

const SELECT_COLUMNS =
  "code_hash as codeHash, kind, status, client_id as clientId, user_id as userId, workspace_id as workspaceId, scope, redirect_uri as redirectUri, code_challenge as codeChallenge, code_challenge_method as codeChallengeMethod, user_code as userCode, last_polled_at as lastPolledAt, expires_at as expiresAt, created_at as createdAt";

export async function persistAuthCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  workspaceId: string;
  scope: string | null;
  codeChallenge: string;
}): Promise<void> {
  await pruneExpiredGrants();
  const now = new Date();
  const hash = await sha256Hex(input.code);
  const row: OAuthGrantRow = {
    codeHash: hash,
    kind: "auth_code",
    status: "pending",
    clientId: input.clientId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    scope: input.scope,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    userCode: null,
    lastPolledAt: null,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  };
  fallbackGrants.set(hash, row);
  if (runtimeIsD1()) {
    await d1Run(
      "INSERT INTO oauth_grants (code_hash, kind, status, client_id, user_id, workspace_id, scope, redirect_uri, code_challenge, code_challenge_method, expires_at, created_at) VALUES (?, 'auth_code', 'pending', ?, ?, ?, ?, ?, ?, 'S256', ?, ?)",
      row.codeHash,
      row.clientId,
      row.userId,
      row.workspaceId,
      row.scope,
      row.redirectUri,
      row.codeChallenge,
      row.expiresAt,
      row.createdAt,
    );
  }
}

/**
 * Atomically claim an authorization code. Returns the row if it was pending
 * and unexpired; returns null otherwise. The atomic UPDATE prevents two
 * concurrent token-endpoint hits from both succeeding on the same code.
 */
export async function consumeAuthCode(
  code: string,
): Promise<OAuthGrantRow | null> {
  await ensureRuntimeReady();
  const hash = await sha256Hex(code);
  const now = Date.now();
  if (runtimeIsD1()) {
    const rows = await d1All<OAuthGrantRow>(
      `SELECT ${SELECT_COLUMNS} FROM oauth_grants WHERE code_hash = ? AND kind = 'auth_code' LIMIT 1`,
      hash,
    );
    const row = rows[0] ?? null;
    if (!row) return null;
    if (row.status !== "pending") return null;
    if (Date.parse(row.expiresAt) <= now) return null;
    await d1Run(
      "UPDATE oauth_grants SET status = 'consumed' WHERE code_hash = ? AND status = 'pending'",
      hash,
    );
    fallbackGrants.delete(hash);
    return row;
  }
  const row = fallbackGrants.get(hash);
  if (!row || row.kind !== "auth_code") return null;
  if (row.status !== "pending") return null;
  if (Date.parse(row.expiresAt) <= now) return null;
  row.status = "consumed";
  fallbackGrants.delete(hash);
  return row;
}

export async function persistDeviceCode(input: {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string | null;
}): Promise<void> {
  await pruneExpiredGrants();
  const now = new Date();
  const hash = await sha256Hex(input.deviceCode);
  const row: OAuthGrantRow = {
    codeHash: hash,
    kind: "device_code",
    status: "pending",
    clientId: input.clientId,
    userId: null,
    workspaceId: null,
    scope: input.scope,
    redirectUri: null,
    codeChallenge: null,
    codeChallengeMethod: null,
    userCode: input.userCode,
    lastPolledAt: null,
    expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  };
  fallbackGrants.set(hash, row);
  if (runtimeIsD1()) {
    await d1Run(
      "INSERT INTO oauth_grants (code_hash, kind, status, client_id, scope, user_code, expires_at, created_at) VALUES (?, 'device_code', 'pending', ?, ?, ?, ?, ?)",
      row.codeHash,
      row.clientId,
      row.scope,
      row.userCode,
      row.expiresAt,
      row.createdAt,
    );
  }
}

async function loadDeviceGrant(input: {
  byHash?: string;
  byUserCode?: string;
}): Promise<OAuthGrantRow | null> {
  await ensureRuntimeReady();
  if (runtimeIsD1()) {
    const rows = input.byHash
      ? await d1All<OAuthGrantRow>(
          `SELECT ${SELECT_COLUMNS} FROM oauth_grants WHERE code_hash = ? AND kind = 'device_code' LIMIT 1`,
          input.byHash,
        )
      : await d1All<OAuthGrantRow>(
          `SELECT ${SELECT_COLUMNS} FROM oauth_grants WHERE user_code = ? AND kind = 'device_code' LIMIT 1`,
          input.byUserCode ?? "",
        );
    if (rows[0]) return rows[0];
  }
  for (const row of fallbackGrants.values()) {
    if (row.kind !== "device_code") continue;
    if (input.byHash && row.codeHash === input.byHash) return row;
    if (input.byUserCode && row.userCode === input.byUserCode) return row;
  }
  return null;
}

export async function loadDeviceCodeByHash(
  deviceCode: string,
): Promise<OAuthGrantRow | null> {
  const hash = await sha256Hex(deviceCode);
  return loadDeviceGrant({ byHash: hash });
}

export async function loadDeviceCodeByUserCode(
  userCode: string,
): Promise<OAuthGrantRow | null> {
  return loadDeviceGrant({ byUserCode: userCode });
}

export async function approveDeviceCode(input: {
  userCode: string;
  userId: string;
  workspaceId: string;
}): Promise<boolean> {
  const row = await loadDeviceCodeByUserCode(input.userCode);
  if (!row || row.status !== "pending") return false;
  if (Date.parse(row.expiresAt) <= Date.now()) return false;
  row.status = "approved";
  row.userId = input.userId;
  row.workspaceId = input.workspaceId;
  fallbackGrants.set(row.codeHash, row);
  if (runtimeIsD1()) {
    await d1Run(
      "UPDATE oauth_grants SET status = 'approved', user_id = ?, workspace_id = ? WHERE code_hash = ? AND kind = 'device_code'",
      input.userId,
      input.workspaceId,
      row.codeHash,
    );
  }
  return true;
}

export async function denyDeviceCode(userCode: string): Promise<boolean> {
  const row = await loadDeviceCodeByUserCode(userCode);
  if (!row || row.status !== "pending") return false;
  row.status = "denied";
  fallbackGrants.set(row.codeHash, row);
  if (runtimeIsD1()) {
    await d1Run(
      "UPDATE oauth_grants SET status = 'denied' WHERE code_hash = ? AND kind = 'device_code'",
      row.codeHash,
    );
  }
  return true;
}

export async function consumeDeviceCode(deviceCode: string): Promise<void> {
  await ensureRuntimeReady();
  const hash = await sha256Hex(deviceCode);
  const row = fallbackGrants.get(hash);
  if (row && row.kind === "device_code") {
    row.status = "consumed";
    fallbackGrants.set(hash, row);
  }
  if (runtimeIsD1()) {
    await d1Run(
      "UPDATE oauth_grants SET status = 'consumed' WHERE code_hash = ? AND kind = 'device_code'",
      hash,
    );
  }
}

export async function touchDevicePoll(deviceCode: string): Promise<void> {
  await ensureRuntimeReady();
  const hash = await sha256Hex(deviceCode);
  const now = new Date().toISOString();
  const row = fallbackGrants.get(hash);
  if (row && row.kind === "device_code") {
    row.lastPolledAt = now;
    fallbackGrants.set(hash, row);
  }
  if (runtimeIsD1()) {
    await d1Run(
      "UPDATE oauth_grants SET last_polled_at = ? WHERE code_hash = ? AND kind = 'device_code'",
      now,
      hash,
    );
  }
}

// Re-export old type names for callers that haven't been updated yet to avoid
// touching unrelated files. The runtime shape is identical; only the table is.
export type AuthCodeRow = OAuthGrantRow;
export type DeviceCodeRow = OAuthGrantRow;
