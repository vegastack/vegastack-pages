import type { APIRoute } from "astro";
import { getRequestActor } from "../../../lib/access";
import {
  clientRedirectUriIsRegistered,
  getOAuthClient,
} from "../../../lib/oauth/clients";
import { persistAuthCode, randomToken } from "../../../lib/oauth/codes";
import { permissionService, workspaceService } from "../../../lib/runtime";

export const prerender = false;

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
  const actor = getRequestActor(cookies);
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

  const member = workspaceService.getMember(workspaceId, actor.user.id);
  const permission = permissionService.resolve({
    user: actor.user,
    member,
    workspaceId,
  });
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
