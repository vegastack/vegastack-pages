import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { checkRateLimit } from "../../lib/runtime";
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_S,
  persistDeviceCode,
  randomToken,
  randomUserCode,
} from "../../lib/oauth/codes";
import { getOAuthClient } from "../../lib/oauth/clients";
import { issuerForRequest } from "../../lib/oauth/issuer";

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
      // ignore
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
      key: `oauth.device:${ip ?? "anonymous"}`,
      limit: 60,
      windowMs: 60 * 60_000,
    });
    return await handleDevice(request);
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      return oauthError("temporarily_unavailable", error.message, 429);
    }
    return oauthError(
      "server_error",
      "Device authorization request failed.",
      500,
    );
  }
};

async function handleDevice(request: Request): Promise<Response> {
  const body = await parseFormOrJson(request);
  const clientId = body.client_id ?? "";
  const scope = body.scope || "mcp";
  if (!clientId) {
    return oauthError("invalid_request", "client_id is required.");
  }
  const client = await getOAuthClient(clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id.");
  }
  const deviceCode = randomToken(32);
  const userCode = randomUserCode();
  await persistDeviceCode({
    deviceCode,
    userCode,
    clientId: client.id,
    scope,
  });
  const origin = issuerForRequest(request);
  const verifyUrl = `${origin}/oauth/device/verify`;
  return Response.json(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verifyUrl,
      verification_uri_complete: `${verifyUrl}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: DEVICE_POLL_INTERVAL_S,
    },
    { status: 200, headers: corsHeaders },
  );
}
