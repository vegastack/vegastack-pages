import type { APIRoute } from "astro";
import { decodePending } from "../authorize";

export const prerender = false;

const PENDING_COOKIE = "vpg_oauth_pending";

export const GET: APIRoute = ({ cookies, url }) => {
  const raw = cookies.get(PENDING_COOKIE)?.value;
  if (!raw) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>OAuth · expired</title><p style="font-family:system-ui;padding:2rem">Your authorization flow has expired. Return to your MCP client and start over.</p>',
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  cookies.delete(PENDING_COOKIE, { path: "/" });
  const params = decodePending(raw);
  if (!params) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>OAuth · bad state</title><p style="font-family:system-ui;padding:2rem">Invalid authorization state. Return to your MCP client and try again.</p>',
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  const target = new URL("/oauth/authorize", url);
  target.searchParams.set("response_type", params.responseType);
  target.searchParams.set("client_id", params.clientId);
  target.searchParams.set("redirect_uri", params.redirectUri);
  target.searchParams.set("scope", params.scope);
  target.searchParams.set("state", params.state);
  target.searchParams.set("code_challenge", params.codeChallenge);
  target.searchParams.set("code_challenge_method", params.codeChallengeMethod);
  if (params.resource) target.searchParams.set("resource", params.resource);
  return Response.redirect(target.toString(), 302);
};
