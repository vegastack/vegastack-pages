import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { audit, rateLimit } from "@vegastack/pages-services";
import { buildServiceContext } from "../../lib/service-context";
import {
  ANTHROPIC_CONNECTOR_CLIENT_ID,
  matchesAnthropicConnector,
  OAuthClientRegistrationError,
  registerOAuthClient,
} from "../../lib/oauth/clients";

export const prerender = false;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
} as const;

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders });

function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

function oauthError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: corsHeaders },
  );
}

// Best-effort audit log push. Writes to D1 via the new audit service;
// failures (e.g. transient D1 errors) are logged and swallowed — the
// OAuth flow shouldn't 500 because we couldn't insert an audit row.
async function recordAudit(
  request: Request,
  input: Parameters<typeof audit.record>[1],
): Promise<void> {
  try {
    const { ctx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      request,
    });
    await audit.record(ctx, input);
  } catch (error) {
    // Structured JSON log so observability tooling can index the
    // `event` key without parsing freeform strings.
    console.log(
      JSON.stringify({
        event: "vpg.oauth.register.audit.failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

const MAX_REGISTRATION_BYTES = 32 * 1024;

export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = clientIp(request);
    // Bound the DCR payload so a hostile registrant can't exhaust Worker
    // memory before we even get to the rate-limit step. The Anthropic
    // fast-path skips D1 + rate-limit, so this is the only ceiling.
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_REGISTRATION_BYTES
    ) {
      return oauthError(
        "invalid_client_metadata",
        "Registration payload is too large.",
        413,
      );
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REGISTRATION_BYTES) {
      return oauthError(
        "invalid_client_metadata",
        "Registration payload is too large.",
        413,
      );
    }
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return oauthError(
        "invalid_client_metadata",
        "Request body must be JSON.",
      );
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).map((value) => String(value))
      : [];
    const clientName = String(body.client_name ?? "").trim();
    const softwareId =
      typeof body.software_id === "string" ? body.software_id : null;
    const softwareVersion =
      typeof body.software_version === "string" ? body.software_version : null;
    const tokenAuth =
      typeof body.token_endpoint_auth_method === "string"
        ? body.token_endpoint_auth_method
        : null;
    if ("client_secret" in body) {
      return oauthError(
        "invalid_client_metadata",
        "Public clients only; do not send client_secret.",
      );
    }

    // Fast path: claude.ai's connector broker re-registers on every Add and
    // its DCR payload has a stable signature (redirect_uris is exactly the
    // Anthropic callback URL). Return the well-known client_id without
    // touching D1 or the rate limiter so the response lands inside the
    // broker's ~1.5s timeout window.
    if (matchesAnthropicConnector({ redirectUris })) {
      await recordAudit(request, {
        workspaceId: null,
        actorUserId: null,
        action: "oauth.client_registered",
        targetType: "oauth_client",
        targetId: ANTHROPIC_CONNECTOR_CLIENT_ID,
        metadata: {
          client_name: clientName || "Claude",
          redirect_uris: redirectUris,
          software_id: softwareId,
          software_version: softwareVersion,
          ua: request.headers.get("user-agent"),
          ip,
          well_known: true,
        },
      });
      return Response.json(
        {
          client_id: ANTHROPIC_CONNECTOR_CLIENT_ID,
          client_id_issued_at: 0,
          client_name: clientName || "Claude",
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          software_id: softwareId,
          software_version: softwareVersion,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        { status: 201, headers: corsHeaders },
      );
    }

    const { ctx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
      request,
    });
    await rateLimit.enforce(ctx, {
      key: `oauth.register:${ip ?? "anonymous"}`,
      limit: 20,
      windowMs: 60 * 60_000,
    });
    const client = await registerOAuthClient({
      clientName,
      redirectUris,
      softwareId,
      softwareVersion,
      tokenEndpointAuthMethod: tokenAuth,
      registeredUserAgent: request.headers.get("user-agent"),
      registeredIp: ip,
    });
    await recordAudit(request, {
      workspaceId: null,
      actorUserId: null,
      action: "oauth.client_registered",
      targetType: "oauth_client",
      targetId: client.id,
      metadata: {
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        software_id: client.softwareId,
        software_version: client.softwareVersion,
        ua: client.registeredUserAgent,
        ip: client.registeredIp,
      },
    });
    return Response.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        software_id: client.softwareId,
        software_version: client.softwareVersion,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "vpg.oauth.register.failed",
        error_code:
          error instanceof OAuthClientRegistrationError
            ? error.oauthError
            : error instanceof AppError
              ? error.code
              : "server_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (error instanceof OAuthClientRegistrationError) {
      return oauthError(error.oauthError, error.message, error.status);
    }
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      return oauthError("temporarily_unavailable", error.message, 429);
    }
    return oauthError("server_error", "OAuth client registration failed.", 500);
  }
};
