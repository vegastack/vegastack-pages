// PATCH /api/workspaces/:id/preferences
//
// Workspace admins update the workspace-default preferences blob.
// Today the only key is `dateTime` ({ dateFormat, timeFormat,
// showRelativeWithinDays }); the route shape is generic so we can
// nest other preferences (notifications, search defaults, …) under
// the same envelope without growing more endpoints.
//
// We merge partials so a partial PATCH (e.g. only dateFormat) leaves
// every other key intact. The merged blob round-trips through
// `readDateTimePrefs` so invalid values can never persist to D1.

import type { APIRoute } from "astro";
import {
  AppError,
  DEFAULT_DATETIME_PREFS,
  readDateTimePrefs,
  type DateFormatKey,
  type DateTimePreferences,
  type TimeFormatKey,
  ALL_DATE_FORMATS,
  ALL_TIME_FORMATS,
} from "@vegastack/pages-core";
import {
  permissions as permissionsService,
  workspaces as workspacesService,
} from "@vegastack/pages-services";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

type Patch = {
  dateTime?: Partial<DateTimePreferences>;
};

function coerceDateTimePatch(
  raw: unknown,
): Partial<DateTimePreferences> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Partial<DateTimePreferences> = {};
  const record = raw as Record<string, unknown>;
  if (typeof record.dateFormat === "string") {
    if (!(ALL_DATE_FORMATS as readonly string[]).includes(record.dateFormat)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `dateFormat must be one of: ${ALL_DATE_FORMATS.join(", ")}.`,
        400,
      );
    }
    out.dateFormat = record.dateFormat as DateFormatKey;
  }
  if (typeof record.timeFormat === "string") {
    if (!(ALL_TIME_FORMATS as readonly string[]).includes(record.timeFormat)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `timeFormat must be one of: ${ALL_TIME_FORMATS.join(", ")}.`,
        400,
      );
    }
    out.timeFormat = record.timeFormat as TimeFormatKey;
  }
  if (typeof record.showRelativeWithinDays === "number") {
    if (
      !Number.isFinite(record.showRelativeWithinDays) ||
      record.showRelativeWithinDays < 0 ||
      record.showRelativeWithinDays > 365
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "showRelativeWithinDays must be between 0 and 365.",
        400,
      );
    }
    out.showRelativeWithinDays = Math.floor(record.showRelativeWithinDays);
  }
  return out;
}

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  try {
    const workspaceId = params.workspaceId;
    if (!workspaceId) {
      throw new AppError("VALIDATION_ERROR", "workspace_id is required.", 400);
    }
    const { ctx, actor } = await buildServiceContext({ cookies, request });
    if (!actor.user) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Sign in to update preferences.",
        401,
      );
    }
    const member = await workspacesService.getMember(ctx, {
      workspaceId,
      userId: actor.user.id,
    });
    const workspacePermission = await permissionsService.resolve(ctx, {
      workspaceId,
      userId: actor.user.id,
      scope: "workspace",
      targetId: workspaceId,
      memberRole: member?.role ?? null,
      instanceRole: actor.user.role,
    });
    permissionsService.assertLevel({
      actual: workspacePermission,
      required: "admin",
    });

    const workspace = await workspacesService.get(ctx, { workspaceId });
    if (!workspace) {
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
      );
    }
    const existingPrefs = readDateTimePrefs(workspace.preferencesJson);

    const body = (await request.json().catch(() => null)) as Patch | null;
    const dateTimePatch = coerceDateTimePatch(body?.dateTime);
    if (!dateTimePatch) {
      // Today we only accept the dateTime key. If someone PATCHes an
      // empty body, no-op success.
      return Response.json({
        preferences: { dateTime: existingPrefs },
      });
    }
    const merged: DateTimePreferences = {
      ...existingPrefs,
      ...dateTimePatch,
    };
    const persisted = JSON.stringify({ dateTime: merged });
    const updated = await workspacesService.setPreferences(ctx, {
      workspaceId,
      preferencesJson: persisted,
    });
    return Response.json({
      preferences: {
        dateTime: readDateTimePrefs(updated.preferencesJson),
      },
      workspace: updated,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Preferences update failed.");
  }
};
