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
const email =
  readOption(args, "--email") ??
  process.env.VPG_LOCAL_ADMIN_EMAIL ??
  "dev@example.com";
const redirectTo = readOption(args, "--redirect-to") ?? "/app";

await assertLocalNodeBackend(baseUrl);

const response = await fetch(`${baseUrl}/api/auth/magic-link/request`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email,
    redirect_to: redirectTo,
  }),
});
const body = await response.json();

if (!response.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

const localLink =
  typeof body.debug_verify_url === "string" ? body.debug_verify_url : null;

console.log(`Requested a local magic link for ${email}.`);
if (localLink) {
  console.log(`Local magic link: ${localLink}`);
  const publicLink = mapPublicUrl(localLink, publicUrl);
  if (publicLink) console.log(`Tunnel magic link: ${publicLink}`);
} else {
  console.log(
    "No debug link was returned. Check the dev server logs for the console email output.",
  );
}
