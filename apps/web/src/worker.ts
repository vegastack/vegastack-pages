// Cloudflare Worker entrypoint.
//
// Astro 6 + @astrojs/cloudflare v13 delegates fetch handling to the
// adapter's `handle()`. We own this file only so we can add a custom
// `scheduled()` handler for the nightly GitHub backup cron and to keep
// the wrangler.jsonc `main` field pointing at a stable path.
//
// `env` and `ctx` are intentionally typed `unknown` here: the entry
// point just forwards both to the adapter. Strongly-typed bindings are
// accessed inside services via `import { env } from "cloudflare:workers"`
// or `apps/web/src/lib/runtime.ts:getRuntimeBindings()`. The wrangler-
// generated `worker-configuration.d.ts` (gitignored) carries the canonical
// `Env` shape for editor tooling.

import { handle } from "@astrojs/cloudflare/handler";
import { runDueGitHubBackupSyncs } from "./lib/github-backup";

type WaitUntilCtx = { waitUntil(promise: Promise<unknown>): void };

export default {
  fetch(request: Request, env: unknown, ctx: WaitUntilCtx) {
    return handle(request, env, ctx);
  },
  scheduled(_controller: unknown, _env: unknown, ctx: WaitUntilCtx) {
    ctx.waitUntil(runDueGitHubBackupSyncs());
  },
};
