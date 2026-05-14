import type { APIRoute } from "astro";
import { getRequestActor } from "../../../lib/access";
import {
  approveDeviceCode,
  denyDeviceCode,
  loadDeviceCodeByUserCode,
} from "../../../lib/oauth/codes";
import { getOAuthClient } from "../../../lib/oauth/clients";
import { vendorForClient } from "../../../lib/oauth/vendor-map";
import { permissionService, workspaceService } from "../../../lib/runtime";

export const prerender = false;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shellPage(
  title: string,
  body: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)} · VegaStack Pages</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0c;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
.card{max-width:480px;width:100%;background:#141416;border:1px solid #25252a;border-radius:14px;padding:2rem}
h1{margin:0 0 0.5rem;font-size:1.4rem}
p{margin:0.5rem 0;line-height:1.5;color:#bdbdc4}
input[type=text]{width:100%;padding:0.7rem;font-size:1.1rem;background:#0b0b0c;color:#e6e6e6;border:1px solid #3a3a42;border-radius:8px;font-family:ui-monospace,monospace;letter-spacing:0.1em;text-align:center}
.actions{display:flex;gap:0.75rem;margin-top:1.5rem}
button{padding:0.7rem 1.2rem;border-radius:8px;border:1px solid transparent;font-size:0.95rem;cursor:pointer;font-weight:500}
.primary{background:#e6e6e6;color:#0b0b0c}
.secondary{background:transparent;color:#bdbdc4;border-color:#3a3a42}
.opt{display:flex;align-items:center;gap:0.6rem;padding:0.6rem;border:1px solid #25252a;border-radius:8px;cursor:pointer;margin-bottom:0.4rem}
</style>
<div class="card">${body}</div>`,
    { status, headers: { "Content-Type": contentType } },
  );
}

export const GET: APIRoute = ({ url, cookies }) => {
  const actor = getRequestActor(cookies);
  if (!actor.user) {
    const next = `/oauth/device/verify${url.search}`;
    return Response.redirect(
      `/app/login?redirect_to=${encodeURIComponent(next)}`,
      302,
    );
  }
  const userCode = url.searchParams.get("user_code") ?? "";
  if (!userCode) {
    return shellPage(
      "Verify device",
      `<h1>Verify device</h1>
       <p>Enter the code shown by your CLI or device.</p>
       <form method="GET">
         <input type="text" name="user_code" autofocus autocomplete="off" />
         <div class="actions">
           <button class="primary" type="submit">Continue</button>
         </div>
       </form>`,
    );
  }
  return loadDeviceCodeByUserCode(userCode).then(async (row) => {
    if (!row) {
      return shellPage(
        "Code not found",
        `<h1>Code not recognized</h1>
         <p>The code <code>${escapeHtml(userCode)}</code> is unknown or expired. Restart the device login in your CLI.</p>`,
        404,
      );
    }
    if (Date.parse(row.expiresAt) <= Date.now()) {
      return shellPage(
        "Code expired",
        `<h1>Code expired</h1>
         <p>This code has expired. Restart the device login in your CLI.</p>`,
        410,
      );
    }
    if (row.status !== "pending") {
      return shellPage(
        "Already used",
        `<h1>Already used</h1>
         <p>This code has already been processed. Restart the device login if you need a new session.</p>`,
        409,
      );
    }
    const client = await getOAuthClient(row.clientId);
    if (!client) {
      return shellPage("Unknown client", "<h1>Unknown client</h1>", 400);
    }
    const vendor = vendorForClient({
      clientName: client.clientName,
      redirectUris: client.redirectUris,
    });
    const workspaces = workspaceService.listWorkspacesForUser(actor.user!.id);
    if (workspaces.length === 0) {
      return shellPage(
        "No workspaces",
        "<h1>No workspaces</h1><p>Your account is not a member of any workspace.</p>",
        403,
      );
    }
    const options = workspaces
      .map(
        (workspace, idx) =>
          `<label class="opt"><input type="radio" name="workspace_id" value="${escapeHtml(workspace.id)}" ${idx === 0 ? "checked" : ""} /> <span>${escapeHtml(workspace.name)}</span></label>`,
      )
      .join("\n");
    return shellPage(
      `Authorize ${vendor.label}`,
      `<h1>${escapeHtml(vendor.label)} wants to access VegaStack Pages</h1>
       <p>Client: <strong>${escapeHtml(client.clientName)}</strong></p>
       <p>Signed in as ${escapeHtml(actor.user!.email)}</p>
       <form method="POST">
         <input type="hidden" name="user_code" value="${escapeHtml(userCode)}" />
         <div style="margin:1.25rem 0">
           <h2 style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;color:#9a9aa3;margin:0 0 0.5rem">Workspace</h2>
           ${options}
         </div>
         <div class="actions">
           <button class="secondary" name="decision" value="deny" type="submit">Cancel</button>
           <button class="primary" name="decision" value="approve" type="submit">Allow ${escapeHtml(vendor.label)}</button>
         </div>
       </form>`,
    );
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const actor = getRequestActor(cookies);
  if (!actor.user) {
    return new Response("Sign-in required.", { status: 401 });
  }
  const form = await request.formData();
  const userCode = String(form.get("user_code") ?? "");
  const decision = String(form.get("decision") ?? "deny");
  const workspaceId = String(form.get("workspace_id") ?? "");
  if (decision !== "approve") {
    await denyDeviceCode(userCode);
    return shellPage(
      "Cancelled",
      "<h1>Cancelled</h1><p>You denied the request. Return to your CLI and start over if needed.</p>",
    );
  }
  const member = workspaceService.getMember(workspaceId, actor.user.id);
  const permission = permissionService.resolve({
    user: actor.user,
    member,
    workspaceId,
  });
  if (permission === "none") {
    return shellPage(
      "No access",
      "<h1>No access</h1><p>You do not have access to the selected workspace.</p>",
      403,
    );
  }
  const approved = await approveDeviceCode({
    userCode,
    userId: actor.user.id,
    workspaceId,
  });
  if (!approved) {
    return shellPage(
      "Could not approve",
      "<h1>Could not approve</h1><p>The code is expired or already used. Start a new device login from your CLI.</p>",
      409,
    );
  }
  return shellPage(
    "All set",
    "<h1>All set</h1><p>You can close this tab and return to your CLI. The login will complete in a few seconds.</p>",
  );
};
