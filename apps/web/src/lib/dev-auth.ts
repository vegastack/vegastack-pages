import type { UserRecord } from "@vegastack/pages-core";
import { workspaceService } from "./runtime";

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

export function devAutoLoginUser(): UserRecord | null {
  return devAutoLoginEnabled()
    ? workspaceService.getUser("usr_demo_admin")
    : null;
}
