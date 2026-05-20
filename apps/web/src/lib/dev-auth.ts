// Dev-only auto-login. When VPG_DEV_AUTO_LOGIN=true, unauthenticated
// requests are resolved against the demo admin user (id
// `usr_demo_admin`) which must already exist in the local D1 — typically
// seeded by `pnpm local:setup`. Disabled by default; never enable in
// production.

import { users } from "@vegastack/pages-services";
import type { UserRecord } from "@vegastack/pages-core";
import { getDb } from "./runtime";

let warned = false;

export function devAutoLoginEnabled() {
  const enabled = process.env.VPG_DEV_AUTO_LOGIN === "true";
  if (enabled && !warned) {
    console.warn(
      "VPG_DEV_AUTO_LOGIN=true is set; unauthenticated requests use the demo admin. Disable it outside local development.",
    );
    warned = true;
  }
  return enabled;
}

// Async D1-direct lookup. Returns the demo admin user when the env var
// is set, else null. Used by access.ts's getRequestActor.
export async function devAutoLoginUser(): Promise<UserRecord | null> {
  if (!devAutoLoginEnabled()) return null;
  const db = await getDb();
  if (!db) return null;
  const ctx = {
    actor: { userId: "", email: null, workspaceId: null },
    db,
    async computeTreeVersion() {
      return "";
    },
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    },
    log() {
      // no-op
    },
  };
  const user = await users.getById(ctx as never, "usr_demo_admin");
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.email,
    role: user.role,
    preferencesJson: user.preferencesJson ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
