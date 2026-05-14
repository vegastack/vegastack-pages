#!/usr/bin/env node
import {
  assertLocalNodeBackend,
  localApiBaseUrl,
  mapPublicUrl,
  portFromArgs,
  readOption,
  resolvePublicUrl,
  stripCommandSeparator,
} from "./local-env.mjs";

const args = stripCommandSeparator(process.argv.slice(2));
const port = portFromArgs(args);
const baseUrl = localApiBaseUrl(args, port);
const publicUrl = resolvePublicUrl(args);
const setupToken =
  readOption(args, "--token") ??
  process.env.VPG_SETUP_TOKEN ??
  "dev-setup-token";
const adminEmail =
  readOption(args, "--email") ??
  process.env.VPG_LOCAL_ADMIN_EMAIL ??
  "dev@example.com";
const adminName =
  readOption(args, "--name") ??
  process.env.VPG_LOCAL_ADMIN_NAME ??
  "Local Admin";
const workspaceName =
  readOption(args, "--workspace") ??
  process.env.VPG_LOCAL_WORKSPACE_NAME ??
  "Local Workspace";

await assertLocalNodeBackend(baseUrl);

const setupStatus = await fetch(`${baseUrl}/api/setup/status`).then(
  (response) => response.json(),
);

if (!setupStatus.setup_required) {
  console.log("Local setup is already complete.");
  const localDirectSignIn = `${baseUrl}/api/auth/dev-login`;
  console.log(`Local direct sign-in: ${localDirectSignIn}`);
  const publicDirectSignIn = mapPublicUrl(localDirectSignIn, publicUrl);
  if (publicDirectSignIn)
    console.log(`Public direct sign-in: ${publicDirectSignIn}`);
  console.log(
    `Optional magic link test: pnpm local:magic-link -- --url ${baseUrl} --email ${adminEmail}`,
  );
  process.exit(0);
}

const response = await fetch(`${baseUrl}/api/setup/complete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    setup_token: setupToken,
    admin_email: adminEmail,
    admin_name: adminName,
    workspace_name: workspaceName,
  }),
});
const body = await response.json();

if (!response.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

const localRedirect = `${baseUrl}${body.redirect_to ?? "/app"}`;
console.log("Seeded the local VegaStack Pages instance.");
console.log(`Admin: ${adminEmail}`);
console.log(`Workspace: ${workspaceName}`);
console.log(`Local page: ${localRedirect}`);
const publicRedirect = mapPublicUrl(localRedirect, publicUrl);
if (publicRedirect) console.log(`Tunnel page: ${publicRedirect}`);
const localDirectSignIn = `${baseUrl}/api/auth/dev-login`;
console.log(`Local direct sign-in: ${localDirectSignIn}`);
const publicDirectSignIn = mapPublicUrl(localDirectSignIn, publicUrl);
if (publicDirectSignIn)
  console.log(`Tunnel direct sign-in: ${publicDirectSignIn}`);
