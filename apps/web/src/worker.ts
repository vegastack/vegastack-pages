import { handle } from "@astrojs/cloudflare/handler";
import { runDueGitHubBackupSyncs } from "./lib/github-backup";

export default {
  async fetch(
    request: Request,
    env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    return handle(request, env, ctx);
  },

  async scheduled(
    _controller: unknown,
    _env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    ctx.waitUntil(runDueGitHubBackupSyncs());
  },
};
