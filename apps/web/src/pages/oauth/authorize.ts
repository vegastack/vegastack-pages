import type { APIRoute } from "astro";
import { workspaces } from "@vegastack/pages-services";
import { getRequestActor } from "../../lib/access";
import {
  clientRedirectUriIsRegistered,
  getOAuthClient,
} from "../../lib/oauth/clients";
import { buildServiceContext } from "../../lib/service-context";
import { vendorForClient } from "../../lib/oauth/vendor-map";

export const prerender = false;

const ALLOWED_RESPONSE_TYPE = "code";
const ALLOWED_PKCE_METHOD = "S256";
const PENDING_COOKIE = "vpg_oauth_pending";
const PENDING_COOKIE_TTL_S = 600;

type AuthorizeParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
};

function parseParams(url: URL): AuthorizeParams {
  return {
    responseType: url.searchParams.get("response_type") ?? "",
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    scope: url.searchParams.get("scope") ?? "mcp",
    state: url.searchParams.get("state") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    codeChallengeMethod:
      url.searchParams.get("code_challenge_method") ?? "S256",
    resource: url.searchParams.get("resource"),
  };
}

function htmlError(title: string, message: string, status = 400) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)} · VegaStack Pages</title>
<style>body{font-family:system-ui;background:#0b0b0c;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
.card{max-width:520px;background:#141416;border:1px solid #25252a;border-radius:12px;padding:2rem}
h1{margin:0 0 0.75rem;font-size:1.25rem}
p{margin:0.5rem 0;line-height:1.5;color:#bdbdc4}</style>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function redirectWithOAuthError(
  redirectUri: string,
  error: string,
  description: string,
  state: string,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const params = parseParams(url);
  if (params.responseType !== ALLOWED_RESPONSE_TYPE) {
    return htmlError(
      "Unsupported request",
      "response_type=code is the only supported value.",
    );
  }
  if (!params.clientId || !params.redirectUri || !params.codeChallenge) {
    return htmlError(
      "Missing parameter",
      "client_id, redirect_uri, and code_challenge are all required.",
    );
  }
  if (params.codeChallengeMethod !== ALLOWED_PKCE_METHOD) {
    return htmlError(
      "Unsupported PKCE method",
      "code_challenge_method must be S256.",
    );
  }
  const client = await getOAuthClient(params.clientId);
  if (!client) {
    return htmlError(
      "Unknown client",
      "This OAuth client_id is not registered. Have the application call /oauth/register first.",
    );
  }
  if (!clientRedirectUriIsRegistered(client, params.redirectUri)) {
    return htmlError(
      "Invalid redirect_uri",
      "redirect_uri does not match any URI registered for this client.",
    );
  }
  const actor = await getRequestActor(cookies);
  if (!actor.user) {
    cookies.set(PENDING_COOKIE, encodePending(params), {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: PENDING_COOKIE_TTL_S,
    });
    const loginPath = import.meta.env.DEV
      ? "/api/auth/dev-login"
      : "/app/login";
    const target = new URL(loginPath, url);
    target.searchParams.set("redirect_to", `${url.pathname}${url.search}`);
    return Response.redirect(target.toString(), 302);
  }
  const { ctx } = await buildServiceContext({ cookies });
  const userWorkspaces = (
    await workspaces.listForUser(ctx, { userId: actor.user.id })
  ).map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
  }));
  if (userWorkspaces.length === 0) {
    return redirectWithOAuthError(
      params.redirectUri,
      "access_denied",
      "Authenticated user has no workspaces.",
      params.state,
    );
  }
  const vendor = vendorForClient({
    clientName: client.clientName,
    redirectUris: client.redirectUris,
  });
  return new Response(
    renderConsent(
      params,
      client,
      userWorkspaces,
      vendor.label,
      actor.user.email,
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
};

function renderConsent(
  params: AuthorizeParams,
  client: { clientName: string; redirectUris: string[] },
  userWorkspaces: Array<{ id: string; name: string; slug: string }>,
  vendorLabel: string,
  email: string,
) {
  const hiddenFields = Object.entries({
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
  })
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value ?? "")}" />`,
    )
    .join("\n");
  const workspaceOptions = userWorkspaces
    .map(
      (workspace, idx) =>
        `<label class="opt"><input type="radio" name="workspace_id" value="${escapeHtml(workspace.id)}" ${idx === 0 ? "checked" : ""} /> <span>${escapeHtml(workspace.name)} <small>${escapeHtml(workspace.slug)}</small></span></label>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Authorize · VegaStack Pages</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0c;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
.card{max-width:480px;width:100%;background:#141416;border:1px solid #25252a;border-radius:14px;padding:2rem}
h1{margin:0 0 0.5rem;font-size:1.4rem}
p{margin:0.5rem 0;line-height:1.5;color:#bdbdc4}
.who{font-size:0.8rem;color:#7a7a82;margin:1rem 0}
.section{margin:1.5rem 0}
.section h2{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;color:#9a9aa3;margin:0 0 0.5rem}
.opt{display:flex;align-items:center;gap:0.6rem;padding:0.6rem;border:1px solid #25252a;border-radius:8px;cursor:pointer;margin-bottom:0.4rem}
.opt small{color:#7a7a82;margin-left:0.4rem}
.opt:hover{border-color:#3a3a42}
.scopes{font-size:0.85rem;color:#bdbdc4;padding-left:1rem}
.scopes li{margin:0.25rem 0}
.actions{display:flex;gap:0.75rem;margin-top:1.5rem}
button{padding:0.7rem 1.2rem;border-radius:8px;border:1px solid transparent;font-size:0.95rem;cursor:pointer;font-weight:500}
.primary{background:#e6e6e6;color:#0b0b0c}
.primary:hover{background:#fff}
.secondary{background:transparent;color:#bdbdc4;border-color:#3a3a42}
.secondary:hover{color:#fff;border-color:#5a5a62}
</style>
<div class="card">
  <h1>${escapeHtml(vendorLabel)} wants to access VegaStack Pages</h1>
  <p>Client: <strong>${escapeHtml(client.clientName)}</strong></p>
  <p class="who">Signed in as ${escapeHtml(email)}</p>
  <form method="POST" action="/oauth/authorize/consent">
    ${hiddenFields}
    <div class="section">
      <h2>Workspace</h2>
      ${workspaceOptions}
    </div>
    <div class="section">
      <h2>Permissions</h2>
      <ul class="scopes">
        <li>Read and edit pages, comments, templates in the selected workspace</li>
        <li>Publish pages and folders</li>
        <li>Cannot manage workspace members or billing</li>
      </ul>
    </div>
    <div class="actions">
      <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
      <button type="submit" name="decision" value="approve" class="primary">Allow ${escapeHtml(vendorLabel)}</button>
    </div>
  </form>
</div>`;
}

function encodePending(params: AuthorizeParams): string {
  const json = JSON.stringify(params);
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodePending(value: string): AuthorizeParams | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const pad =
      padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const decoded = atob(padded + pad);
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as AuthorizeParams;
    if (
      typeof parsed.clientId === "string" &&
      typeof parsed.redirectUri === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
