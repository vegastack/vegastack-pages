// Settings page bootstrap — resolves the actor, picks the active
// workspace from URL/cookie/membership, and loads the per-workspace
// pages/folders. Plan 011 §4 (no legacy singletons). All reads via
// @vegastack/pages-services + D1.

import type { AstroGlobal } from "astro";
import {
  hasPermission,
  type PermissionLevel,
  type FolderRecord,
  type PageRecord,
  type UserRecord,
  type WorkspaceRecord,
} from "@vegastack/pages-core";
import { getRequestActor } from "./access";
import { publicSignupEnabled } from "./deployment";
import { getDb } from "./runtime";
import {
  folders as foldersService,
  pages as pagesService,
  permissions as permissionsService,
  workspaces as workspacesService,
  type ServiceContext,
} from "@vegastack/pages-services";
import { listSelectableWorkspaces } from "./workspace-visibility";

export type SettingsContext = {
  currentUser: UserRecord;
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  pages: PageRecord[];
  folders: FolderRecord[];
  effectivePermission: PermissionLevel;
};

export type SettingsLoad =
  | { kind: "ok"; context: SettingsContext }
  | { kind: "redirect"; response: Response };

function readOnlyCtx(user: UserRecord | null): ServiceContext {
  return {
    actor: {
      userId: user?.id ?? "",
      email: user?.email ?? null,
      workspaceId: null,
    },
    async computeTreeVersion() {
      return "";
    },
    waitUntil(promise) {
      void promise.catch(() => undefined);
    },
    log(level, message, fields) {
      const emit =
        level === "error" || level === "warn" ? console.error : console.log;
      emit(`[vpg-settings] [${level}] ${message}`, fields ?? {});
    },
  };
}

export async function loadSettings(Astro: AstroGlobal): Promise<SettingsLoad> {
  const actor = await getRequestActor(Astro.cookies);
  if (!actor.user) {
    return { kind: "redirect", response: Astro.redirect("/app/login") };
  }
  const currentUser = actor.user;

  const workspaces = await listSelectableWorkspaces(currentUser);
  // Active workspace resolution: URL > cookie > first available
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

  const db = await getDb();
  const ctx = readOnlyCtx(currentUser);
  if (db) ctx.db = db;
  const member = await workspacesService.getMember(ctx, {
    workspaceId: workspace.id,
    userId: currentUser.id,
  });
  const effectivePermission = await permissionsService.resolve(ctx, {
    workspaceId: workspace.id,
    userId: currentUser.id,
    scope: "workspace",
    targetId: workspace.id,
    memberRole: member?.role ?? null,
    instanceRole: currentUser.role,
  });

  if (!hasPermission(effectivePermission, "admin")) {
    const allPages = await pagesService.list(ctx, workspace.id);
    const firstPage = allPages[0];
    return {
      kind: "redirect",
      response: Astro.redirect(firstPage ? `/p/${firstPage.slugId}` : "/"),
    };
  }

  const [pages, folders] = await Promise.all([
    pagesService.list(ctx, workspace.id),
    foldersService.listAll(ctx, { workspaceId: workspace.id }),
  ]);

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

export function splitDate(value: string | null | undefined): {
  date: string;
  time: string | null;
} {
  if (!value) return { date: "Never", time: null };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date: value, time: null };
  return {
    date: parsed.toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    time: parsed.toLocaleTimeString("en", {
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}
