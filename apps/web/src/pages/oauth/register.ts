import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { auditService, checkRateLimit } from "../../lib/runtime";
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

// Best-effort access to Cloudflare's ExecutionContext.waitUntil. When the
// adapter exposes it via Astro.locals.runtime.ctx we use it to defer the
// audit-log INSERT until after the response has been sent; otherwise we fall
// back to fire-and-forget. The point is to keep /register response time well
// under the ~1.5s window claude.ai's connector broker waits for DCR before
// it cancels the request.
function deferOnRuntime(
  locals: Record<string, unknown> | undefined,
  promise: Promise<unknown>,
): void {
  const runtime = locals && (locals.runtime as { ctx?: unknown } | undefined);
  const ctx = runtime?.ctx as
    | { waitUntil?: (p: Promise<unknown>) => void }
    | undefined;
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(promise.catch(() => undefined));
    return;
  }
  // Node adapter / dev: no ExecutionContext, just swallow the rejection so an
  // audit-log failure doesn't surface as an unhandled rejection.
  promise.catch(() => undefined);
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const ip = clientIp(request);
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
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
      deferOnRuntime(
        locals as unknown as Record<string, unknown> | undefined,
        Promise.resolve().then(() =>
          auditService.record({
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
          }),
        ),
      );
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

    await checkRateLimit({
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
    // Defer audit-log INSERT so the 201 response lands sooner. Two D1 writes
    // (client INSERT + audit INSERT) was pushing us past claude.ai's broker
    // timeout. The client INSERT is load-bearing (subsequent /authorize and
    // /token calls look up the client by id and must find it), the audit row
    // is not.
    deferOnRuntime(
      locals as unknown as Record<string, unknown> | undefined,
      Promise.resolve().then(() =>
        auditService.record({
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
        }),
      ),
    );
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
    if (error instanceof OAuthClientRegistrationError) {
      return oauthError(error.oauthError, error.message, error.status);
    }
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      return oauthError("temporarily_unavailable", error.message, 429);
    }
    return oauthError("server_error", "OAuth client registration failed.", 500);
  }
};
