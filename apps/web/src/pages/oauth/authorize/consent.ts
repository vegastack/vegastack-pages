import type { APIRoute } from "astro";
import {
  getApiRequestActor,
  resolveWorkspaceActorPermission,
} from "../../../lib/access";
import { sameOrigin } from "../../../lib/csrf";
import {
  clientRedirectUriIsRegistered,
  getOAuthClient,
} from "../../../lib/oauth/clients";
import { persistAuthCode, randomToken } from "../../../lib/oauth/codes";

export const prerender = false;

// The consent POST sits inside the middleware's CSRF-bypass allowlist
// (Bearer-authenticated endpoints don't pay the CSRF tax). This route is
// the exception — it IS a cookie-authenticated browser mutation. Enforce
// origin in-handler so a cross-site auto-submit form can't trick a
// logged-in user into approving an OAuth grant for an attacker-controlled
// (DCR-registered) client.
function originIsTrustedForConsent(request: Request): boolean {
  // Sec-Fetch-Site=same-origin is the strongest signal modern browsers
  // emit; same-origin Origin header is the fallback for older agents.
  const fetchSite = request.headers.get("sec-fetch-site");
  // Sec-Fetch-Dest tells us what kind of request initiated this. We
  // want only top-level document submissions ("document") — anything
  // initiated from an iframe (`iframe`), object/embed, or sub-fetch
  // (`empty` from script) is rejected. Defense-in-depth against an
  // attacker that loads the consent page in an iframe and auto-clicks
  // the approve button. Browsers without Sec-Fetch-Dest (very old)
  // fall through to the same-origin checks below.
  const fetchDest = request.headers.get("sec-fetch-dest");
  if (fetchDest && fetchDest !== "document") return false;
  if (fetchSite === "same-origin") return true;
  if (fetchSite && fetchSite !== "same-origin") return false;
  return sameOrigin(request);
}

function redirectWith(
  redirectUri: string,
  params: Record<string, string>,
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return Response.redirect(url.toString(), 303);
}

function htmlError(message: string, status = 400): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>OAuth error</title><pre style="font-family:system-ui;padding:2rem">${message
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")}</pre>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!originIsTrustedForConsent(request)) {
    return htmlError("Cross-site consent submissions are not allowed.", 403);
  }
  const actor = await getApiRequestActor(cookies, request);
  if (!actor.user) {
    return htmlError(
      "Sign-in required. Sign in and retry the connector flow.",
      401,
    );
  }
  const form = await request.formData();
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const scope = String(form.get("scope") ?? "mcp");
  const codeChallenge = String(form.get("code_challenge") ?? "");
  const codeChallengeMethod = String(
    form.get("code_challenge_method") ?? "S256",
  );
  const workspaceId = String(form.get("workspace_id") ?? "");
  const decision = String(form.get("decision") ?? "deny");

  const client = await getOAuthClient(clientId);
  if (!client || !clientRedirectUriIsRegistered(client, redirectUri)) {
    return htmlError("Invalid client or redirect_uri.", 400);
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return htmlError("PKCE S256 challenge is required.", 400);
  }

  if (decision !== "approve") {
    return redirectWith(redirectUri, {
      error: "access_denied",
      error_description: "User denied the authorization request.",
      ...(state ? { state } : {}),
    });
  }

  const permission = await resolveWorkspaceActorPermission(actor, workspaceId);
  if (permission === "none") {
    return htmlError("You do not have access to the selected workspace.", 403);
  }

  const code = randomToken(32);
  await persistAuthCode({
    code,
    clientId: client.id,
    redirectUri,
    userId: actor.user.id,
    workspaceId,
    scope,
    codeChallenge,
  });

  return redirectWith(redirectUri, {
    code,
    ...(state ? { state } : {}),
  });
};
