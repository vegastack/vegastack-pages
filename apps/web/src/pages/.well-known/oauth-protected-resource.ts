import type { APIRoute } from "astro";
import { issuerForRequest, resourceForRequest } from "../../lib/oauth/issuer";

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
      resource: resourceForRequest(request),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/docs/quickstart`,
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
