import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  auditService,
  checkRateLimit,
  createMcpSession,
  findMcpSessionByRefreshToken,
  rotateMcpSessionTokens,
} from "../../lib/runtime";
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
import { getOAuthClient } from "../../lib/oauth/clients";

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

async function parseFormOrJson(
  request: Request,
): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  const result: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = String(value ?? "");
      }
    } catch {
      // ignore; will be caught downstream
    }
    return result;
  }
  const form = await request.formData();
  for (const [key, value] of form.entries()) {
    result[key] = String(value);
  }
  return result;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = clientIp(request);
    await checkRateLimit({
      key: `oauth.token:${ip ?? "anonymous"}`,
      limit: 60,
      windowMs: 60_000,
    });
    const body = await parseFormOrJson(request);
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
    return oauthError("server_error", "OAuth token issuance failed.", 500);
  }
};

async function handleAuthorizationCode(
  body: Record<string, string>,
  request: Request,
): Promise<Response> {
  const code = body.code ?? "";
  const codeVerifier = body.code_verifier ?? "";
  const clientId = body.client_id ?? "";
  const redirectUri = body.redirect_uri ?? "";
  if (!code || !codeVerifier || !clientId || !redirectUri) {
    return oauthError(
      "invalid_request",
      "code, code_verifier, client_id, and redirect_uri are required.",
    );
  }
  const client = await getOAuthClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client_id.");
  const row = await consumeAuthCode(code);
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
  const issued = await createMcpSession({
    workspaceId: row.workspaceId,
    userId: row.userId,
    clientName: client.clientName,
    kind: "oauth",
    scope: row.scope ?? "mcp",
    ttlMs: ACCESS_TOKEN_TTL_MS,
    userAgent: ua,
    lastOrigin: origin,
    oauthClientId: client.id,
    refreshTokenExpiresAt: new Date(
      Date.now() + REFRESH_TOKEN_TTL_MS,
    ).toISOString(),
  });
  auditService.record({
    workspaceId: row.workspaceId,
    actorUserId: row.userId,
    action: "oauth.session_issued",
    targetType: "mcp_session",
    targetId: issued.session.id,
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
      access_token: issued.rawToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: issued.refreshToken,
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
  const clientId = body.client_id ?? "";
  if (!refreshToken || !clientId) {
    return oauthError(
      "invalid_request",
      "refresh_token and client_id are required.",
    );
  }
  const session = await findMcpSessionByRefreshToken(refreshToken);
  if (!session) {
    return oauthError("invalid_grant", "Refresh token is invalid or expired.");
  }
  const ua = request.headers.get("user-agent");
  const origin = request.headers.get("origin");
  const rotated = await rotateMcpSessionTokens({
    sessionId: session.id,
    ttlMs: ACCESS_TOKEN_TTL_MS,
    refreshTtlMs: REFRESH_TOKEN_TTL_MS,
    userAgent: ua,
    lastOrigin: origin,
  });
  if (!rotated) {
    return oauthError("invalid_grant", "Refresh token could not be rotated.");
  }
  auditService.record({
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
      access_token: rotated.rawToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: rotated.refreshToken,
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
  const clientId = body.client_id ?? "";
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
  const issued = await createMcpSession({
    workspaceId: row.workspaceId,
    userId: row.userId,
    clientName: client.clientName,
    kind: "oauth",
    scope: row.scope ?? "mcp",
    ttlMs: ACCESS_TOKEN_TTL_MS,
    userAgent: ua,
    oauthClientId: client.id,
    refreshTokenExpiresAt: new Date(
      Date.now() + REFRESH_TOKEN_TTL_MS,
    ).toISOString(),
  });
  await consumeDeviceCode(deviceCode);
  auditService.record({
    workspaceId: row.workspaceId,
    actorUserId: row.userId,
    action: "oauth.session_issued",
    targetType: "mcp_session",
    targetId: issued.session.id,
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
      access_token: issued.rawToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: issued.refreshToken,
      scope: row.scope ?? "mcp",
      workspace_id: row.workspaceId,
    },
    { status: 200, headers: corsHeaders },
  );
}
