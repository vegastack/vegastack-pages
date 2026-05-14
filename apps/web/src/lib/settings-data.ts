import type { AstroGlobal } from "astro";
import { hasPermission } from "@vegastack/pages-core";
import { getRequestActor } from "./access";
import { publicSignupEnabled } from "./deployment";
import {
  ensureSeedData,
  pageService,
  permissionService,
  workspaceService,
} from "./runtime";
import { listSelectableWorkspaces } from "./workspace-visibility";

export type SettingsContext = {
  currentUser: NonNullable<ReturnType<typeof getRequestActor>["user"]>;
  workspace: NonNullable<ReturnType<typeof listSelectableWorkspaces>[number]>;
  workspaces: ReturnType<typeof listSelectableWorkspaces>;
  pages: ReturnType<typeof pageService.listPages>;
  folders: ReturnType<typeof workspaceService.listFolders>;
  effectivePermission: ReturnType<typeof permissionService.resolve>;
};

export type SettingsLoad =
  | { kind: "ok"; context: SettingsContext }
  | { kind: "redirect"; response: Response };

export async function loadSettings(Astro: AstroGlobal): Promise<SettingsLoad> {
  if (!publicSignupEnabled()) {
    await ensureSeedData();
  }

  const actor = getRequestActor(Astro.cookies);
  if (!actor.user) {
    return { kind: "redirect", response: Astro.redirect("/app/login") };
  }
  const currentUser = actor.user;

  const workspaces = listSelectableWorkspaces(currentUser);
  /*
   * Active workspace resolution:
   *  1. ?workspace_id= in the URL — one-shot switch (workspace switcher).
   *  2. vpg-active-workspace cookie — sticky preference from a previous
   *     switch. Lets the user's URLs stay clean.
   *  3. First workspace the user belongs to — fallback for a fresh session.
   *
   * After resolving, we persist the choice to the cookie and — if the URL
   * carried the param — redirect to the same path without it so the
   * address bar reads as a clean `/app/settings/<section>`.
   */
  const urlWorkspaceId = Astro.url.searchParams.get("workspace_id");
  const cookieWorkspaceId =
    Astro.cookies.get("vpg-active-workspace")?.value ?? null;
  const requestedWorkspaceId = urlWorkspaceId ?? cookieWorkspaceId;
  const workspace =
    workspaces.find((item) => item.id === requestedWorkspaceId) ??
    workspaces[0] ??
    null;
  if (!workspace) {
    return {
      kind: "redirect",
      response: Astro.redirect(
        publicSignupEnabled() ? "/app/signup" : "/app/setup",
      ),
    };
  }
  Astro.cookies.set("vpg-active-workspace", workspace.id, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  if (urlWorkspaceId) {
    const cleanUrl = new URL(Astro.url);
    cleanUrl.searchParams.delete("workspace_id");
    const target = cleanUrl.pathname + (cleanUrl.search || "");
    return { kind: "redirect", response: Astro.redirect(target) };
  }

  const member = workspaceService.getMember(workspace.id, currentUser.id);
  const effectivePermission = permissionService.resolve({
    user: currentUser,
    member,
    workspaceId: workspace.id,
  });

  if (!hasPermission(effectivePermission, "admin")) {
    const firstPage = pageService.listPages(workspace.id)[0];
    return {
      kind: "redirect",
      response: Astro.redirect(firstPage ? `/p/${firstPage.slugId}` : "/"),
    };
  }

  const pages = pageService.listPages(workspace.id);
  const folders = workspaceService.listFolders(workspace.id);

  return {
    kind: "ok",
    context: {
      currentUser,
      workspace,
      workspaces,
      pages,
      folders,
      effectivePermission,
    },
  };
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}
