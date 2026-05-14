import type { APIRoute } from "astro";
import { issuerForRequest } from "../../lib/oauth/issuer";

export const prerender = false;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
} as const;

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders });

export const GET: APIRoute = ({ request }) => {
  const origin = issuerForRequest(request);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      device_authorization_endpoint: `${origin}/oauth/device`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
    },
    {
      headers: {
        ...corsHeaders,
        "Cache-Control": "public, max-age=300",
      },
    },
  );
};
