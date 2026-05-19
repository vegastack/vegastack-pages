import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { audit, mcpSessions, rateLimit } from "@vegastack/pages-services";
import { buildServiceContext } from "../../lib/service-context";
import { sha256Hex } from "../../lib/runtime";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  consumeAuthCode,
  consumeDeviceCode,
  loadDeviceCodeByHash,
  touchDevicePoll,
  verifyPkceS256,
  DEVICE_POLL_INTERVAL_S,
} from "../../lib/oauth/codes";
import {
  ANTHROPIC_CONNECTOR_CLIENT_ID,
  getOAuthClient,
} from "../../lib/oauth/clients";

const ACCESS_TOKEN_TTL_S = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);
const REFRESH_TOKEN_TTL_S = Math.floor(REFRESH_TOKEN_TTL_MS / 1000);

function mintRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function refreshTokenHashFor(rawToken: string): Promise<string> {
  return `mcp_${await sha256Hex(rawToken)}`;
}

export const prerender = false;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders });

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: corsHeaders },
  );
}

function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

// Max bytes the OAuth token endpoint will accept for the request
// body. Token requests are always short (a code + verifier + a few
// flags). Cap so a hostile or buggy client can't tie up the Worker
// allocating gigabytes before validation.
const MAX_TOKEN_BODY_BYTES = 16 * 1024;

async function parseFormOrJson(
  request: Request,
): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  // Pre-check Content-Length so we can reject without ever touching the
  // body bytes. The downstream text/JSON read still re-bounds, so a
  // missing or lying header can't bypass the cap.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_TOKEN_BODY_BYTES) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      "OAuth token request body is too large.",
      413,
    );
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_TOKEN_BODY_BYTES) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      "OAuth token request body is too large.",
      413,
    );
  }
  const result: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    if (!raw) return result;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = String(value ?? "");
      }
    } catch {
      // ignore; will be caught downstream
    }
    return result;
  }
  const params = new URLSearchParams(raw);
  for (const [key, value] of params.entries()) {
    result[key] = String(value);
  }
  return result;
}

function clientIdFromBodyOrBasic(
  body: Record<string, string>,
  request: Request,
): string {
  const bodyClientId = body.client_id?.trim();
  if (bodyClientId) return bodyClientId;
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return "";
  try {
    const decoded = atob(header.slice("basic ".length).trim());
    const separator = decoded.indexOf(":");
    const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    // We only support public OAuth clients. Accept Basic as a compatibility
    // transport for the client_id when the secret/password part is empty.
    return password ? "" : decodeURIComponent(username).trim();
  } catch {
    return "";
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = clientIp(request);
    const body = await parseFormOrJson(request);
    // Anthropic's broker has a short token-exchange timeout. The auth-code
    // grant is already one-time, PKCE-bound, and short-lived, so avoid putting
    // a D1 rate-limit write in front of code consumption for this well-known
    // public client.
    if (
      clientIdFromBodyOrBasic(body, request) !== ANTHROPIC_CONNECTOR_CLIENT_ID
    ) {
      const { ctx } = await buildServiceContext({
        cookies: { get: () => undefined } as never,
        request,
      });
      await rateLimit.enforce(ctx, {
        key: `oauth.token:${ip ?? "anonymous"}`,
        limit: 60,
        windowMs: 60_000,
      });
    }
    const grantType = body.grant_type ?? "";
    if (grantType === "authorization_code") {
      return await handleAuthorizationCode(body, request);
    }
    if (grantType === "refresh_token") {
      return await handleRefreshToken(body, request);
    }
    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      return await handleDeviceCode(body, request);
    }
    return oauthError(
      "unsupported_grant_type",
      `Unsupported grant_type: ${grantType || "(missing)"}`,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      return oauthError("temporarily_unavailable", error.message, 429);
    }
    if (error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE") {
      return oauthError("invalid_request", error.message, 413);
    }
    return oauthError("server_error", "OAuth token issuance failed.", 500);
  }
};

async function handleAuthorizationCode(
  body: Record<string, string>,
  request: Request,
): Promise<Response> {
  const code = body.code ?? "";
  const codeVerifier = body.code_verifier ?? "";
  const clientId = clientIdFromBodyOrBasic(body, request);
  const redirectUri = body.redirect_uri ?? "";
  if (!code || !codeVerifier || !clientId || !redirectUri) {
    return oauthError(
      "invalid_request",
      "code, code_verifier, client_id, and redirect_uri are required.",
    );
  }
  const client = await getOAuthClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client_id.");
  // Pass clientId into consumeAuthCode so the SQL UPDATE includes
  // `AND client_id = ?` — a mismatched client_id never burns the code,
  // letting the legit client retry with the right value. The explicit
  // post-consume mismatch check is now defensive only.
  const row = await consumeAuthCode(code, client.id);
  if (!row)
    return oauthError("invalid_grant", "Auth code is invalid or expired.");
  if (row.clientId !== client.id) {
    return oauthError(
      "invalid_grant",
      "client_id does not match the issued code.",
    );
  }
  if (row.redirectUri !== redirectUri) {
    return oauthError(
      "invalid_grant",
      "redirect_uri does not match the issued code.",
    );
  }
  // The schema CHECK constraint guarantees auth_code rows carry redirect_uri,
  // code_challenge, user_id, and workspace_id. Narrow the row type defensively
  // so a corrupt row can't crash the token endpoint with a runtime cast.
  if (!row.codeChallenge || !row.userId || !row.workspaceId) {
    return oauthError("invalid_grant", "Auth code is missing required fields.");
  }
  const pkceOk = await verifyPkceS256(codeVerifier, row.codeChallenge);
  if (!pkceOk) {
    return oauthError("invalid_grant", "PKCE verification failed.");
  }
  const ua = request.headers.get("user-agent");
  const origin = request.headers.get("origin");
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    request,
    workspaceId: row.workspaceId,
  });
  // Create the underlying agent session first, then the MCP session
  // bound to it. The new service splits these (legacy used to bundle).
  const agent = await mcpSessions.createAgentSession(ctx, {
    workspaceId: row.workspaceId,
    userId: row.userId,
    clientName: client.clientName,
    kind: "oauth",
    userAgent: ua ?? undefined,
    oauthClientId: client.id,
  });
  if (origin) {
    await mcpSessions.touchAgentSession(ctx, {
      sessionId: agent.id,
      origin,
    });
  }
  const rawRefreshToken = mintRefreshToken();
  const refreshTokenHash = await refreshTokenHashFor(rawRefreshToken);
  const session = await mcpSessions.createMcpSession(ctx, {
    workspaceId: row.workspaceId,
    userId: row.userId,
    agentSessionId: agent.id,
    scope: row.scope ?? "mcp",
    ttlSeconds: ACCESS_TOKEN_TTL_S,
    refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_S,
    refreshTokenHash,
    protocolVersion: "2025-11-25",
  });
  await audit.record(ctx, {
    workspaceId: row.workspaceId,
    actorUserId: row.userId,
    action: "oauth.session_issued",
    targetType: "mcp_session",
    targetId: session.id,
    metadata: {
      client_id: client.id,
      client_name: client.clientName,
      scope: row.scope,
      redirect_uri: redirectUri,
      ua,
      origin,
      flow: "code",
    },
  });
  return Response.json(
    {
      access_token: session.id,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: rawRefreshToken,
      scope: row.scope ?? "mcp",
      workspace_id: row.workspaceId,
    },
    { status: 200, headers: corsHeaders },
  );
}

async function handleRefreshToken(
  body: Record<string, string>,
  request: Request,
): Promise<Response> {
  const refreshToken = body.refresh_token ?? "";
  const clientId = clientIdFromBodyOrBasic(body, request);
  if (!refreshToken || !clientId) {
    return oauthError(
      "invalid_request",
      "refresh_token and client_id are required.",
    );
  }
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    request,
  });
  // Refresh tokens are stored as `mcp_${sha256(rawToken)}` in the DB. Hash
  // before looking up.
  const suppliedHash = await refreshTokenHashFor(refreshToken);
  const session = await mcpSessions.findByRefreshToken(ctx, suppliedHash);
  if (!session) {
    // Replay detection: if this hash matches a PREVIOUS refresh token
    // (already rotated away), treat as compromise and revoke the entire
    // session chain. RFC 6749 §10.4.
    const replayed = await mcpSessions.findByPreviousRefreshToken(
      ctx,
      suppliedHash,
    );
    if (replayed) {
      await mcpSessions.revoke(ctx, replayed.id);
      await audit.record(ctx, {
        workspaceId: replayed.workspaceId,
        actorUserId: replayed.userId,
        action: "oauth.refresh_replay_detected",
        targetType: "mcp_session",
        targetId: replayed.id,
        metadata: { client_id: clientId },
      });
    }
    return oauthError("invalid_grant", "Refresh token is invalid or expired.");
  }
  // RFC 6749 §10.4: refresh tokens are bound to the issuing client. Reject
  // attempts to redeem under a different client_id even if the token is
  // otherwise valid. The bound oauth_client_id lives on the agent session
  // the MCP session was created from.
  if (session.agentSessionId) {
    const agentSession = await mcpSessions.getAgentSession(
      ctx,
      session.agentSessionId,
    );
    if (
      agentSession?.oauthClientId &&
      agentSession.oauthClientId !== clientId
    ) {
      return oauthError(
        "invalid_grant",
        "Refresh token does not belong to this client.",
      );
    }
  }
  const newRawRefreshToken = mintRefreshToken();
  const newRefreshTokenHash = await refreshTokenHashFor(newRawRefreshToken);
  const rotated = await mcpSessions.rotateTokens(ctx, {
    sessionId: session.id,
    newRefreshTokenHash,
    ttlSeconds: ACCESS_TOKEN_TTL_S,
    refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_S,
  });
  await audit.record(ctx, {
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    action: "oauth.session_refreshed",
    targetType: "mcp_session",
    targetId: session.id,
    metadata: {
      client_id: clientId,
      scope: session.scope,
    },
  });
  return Response.json(
    {
      access_token: rotated.id,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: newRawRefreshToken,
      scope: session.scope ?? "mcp",
    },
    { status: 200, headers: corsHeaders },
  );
}

async function handleDeviceCode(
  body: Record<string, string>,
  request: Request,
): Promise<Response> {
  const deviceCode = body.device_code ?? "";
  const clientId = clientIdFromBodyOrBasic(body, request);
  if (!deviceCode || !clientId) {
    return oauthError(
      "invalid_request",
      "device_code and client_id are required.",
    );
  }
  const row = await loadDeviceCodeByHash(deviceCode);
  if (!row || row.clientId !== clientId) {
    return oauthError("invalid_grant", "Unknown device_code.");
  }
  if (Date.parse(row.expiresAt) <= Date.now()) {
    return oauthError("expired_token", "device_code expired.");
  }
  if (row.lastPolledAt) {
    const sincePoll = (Date.now() - Date.parse(row.lastPolledAt)) / 1000;
    if (sincePoll < DEVICE_POLL_INTERVAL_S) {
      await touchDevicePoll(deviceCode);
      return oauthError(
        "slow_down",
        "Wait at least the interval seconds between polls.",
        400,
      );
    }
  }
  await touchDevicePoll(deviceCode);
  if (row.status === "pending") {
    return oauthError(
      "authorization_pending",
      "User has not yet completed verification.",
      400,
    );
  }
  if (row.status === "denied") {
    return oauthError("access_denied", "User denied the request.", 400);
  }
  if (row.status === "consumed") {
    return oauthError("invalid_grant", "device_code already used.");
  }
  if (row.status !== "approved" || !row.userId || !row.workspaceId) {
    return oauthError("invalid_grant", "device_code is not in a usable state.");
  }
  const client = await getOAuthClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client_id.");
  const ua = request.headers.get("user-agent");
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    request,
    workspaceId: row.workspaceId,
  });
  const agent = await mcpSessions.createAgentSession(ctx, {
    workspaceId: row.workspaceId,
    userId: row.userId,
    clientName: client.clientName,
    kind: "oauth",
    userAgent: ua ?? undefined,
    oauthClientId: client.id,
  });
  const rawRefreshToken = mintRefreshToken();
  const refreshTokenHash = await refreshTokenHashFor(rawRefreshToken);
  const session = await mcpSessions.createMcpSession(ctx, {
    workspaceId: row.workspaceId,
    userId: row.userId,
    agentSessionId: agent.id,
    scope: row.scope ?? "mcp",
    ttlSeconds: ACCESS_TOKEN_TTL_S,
    refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_S,
    refreshTokenHash,
    protocolVersion: "2025-11-25",
  });
  await consumeDeviceCode(deviceCode);
  await audit.record(ctx, {
    workspaceId: row.workspaceId,
    actorUserId: row.userId,
    action: "oauth.session_issued",
    targetType: "mcp_session",
    targetId: session.id,
    metadata: {
      client_id: client.id,
      client_name: client.clientName,
      scope: row.scope,
      flow: "device",
      ua,
    },
  });
  return Response.json(
    {
      access_token: session.id,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: rawRefreshToken,
      scope: row.scope ?? "mcp",
      workspace_id: row.workspaceId,
    },
    { status: 200, headers: corsHeaders },
  );
}
