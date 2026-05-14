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

function printOpenLinks(label, localUrl) {
  console.log(`${label}: ${localUrl}`);
  const publicUrlValue = mapPublicUrl(localUrl, publicUrl);
  if (publicUrlValue)
    console.log(`${label.replace("Local", "Public")}: ${publicUrlValue}`);
}

await assertLocalNodeBackend(baseUrl);

const setupStatus = await fetch(`${baseUrl}/api/setup/status`).then(
  (response) => response.json(),
);
const setupWasRequired = Boolean(setupStatus.setup_required);

if (setupWasRequired) {
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
  console.log("Seeded the local VegaStack Pages instance.");
  console.log(`Admin: ${adminEmail}`);
  console.log(`Workspace: ${workspaceName}`);
  if (body.redirect_to) {
    printOpenLinks("Local first page", `${baseUrl}${body.redirect_to}`);
  }
} else {
  console.log("Local setup is already complete.");
  console.log(
    "Use the existing local admin email, or run pnpm local:reset for a fresh instance.",
  );
}

printOpenLinks("Local direct sign-in", `${baseUrl}/api/auth/dev-login`);
console.log(
  "Use direct sign-in for local development. Magic links are optional and only work for existing local users.",
);

const magicResponse = await fetch(`${baseUrl}/api/auth/magic-link/request`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: adminEmail,
    redirect_to: "/app",
  }),
});
const magicBody = await magicResponse.json();
if (!magicResponse.ok) {
  console.error(JSON.stringify(magicBody, null, 2));
  if (!setupWasRequired) {
    console.log(
      "Skipped optional magic link output. For a different local admin email, run pnpm local:reset first, then pnpm local:setup -- --email <email>.",
    );
    process.exit(0);
  }
  process.exit(1);
}

const localMagicLink =
  typeof magicBody.debug_verify_url === "string"
    ? magicBody.debug_verify_url
    : null;

if (localMagicLink) {
  printOpenLinks("Local magic link", localMagicLink);
} else {
  console.log("Magic link requested. Check the dev server logs.");
}
