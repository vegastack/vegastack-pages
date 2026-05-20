// PATCH /api/me/preferences — per-user override of the datetime
// (and future) preferences. Same shape as the workspace endpoint
// minus the admin gate (the actor edits their own row).
//
// A user can clear an override by sending `null` for any key —
// the merged blob drops that key and falls back to the workspace
// default at render time.

import type { APIRoute } from "astro";
import {
  AppError,
  ALL_DATE_FORMATS,
  ALL_TIME_FORMATS,
  readDateTimePrefs,
  type DateFormatKey,
  type DateTimePreferences,
  type TimeFormatKey,
} from "@vegastack/pages-core";
import { users as usersService } from "@vegastack/pages-services";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";

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

export const PATCH: APIRoute = async ({ cookies, request }) => {
  try {
    const { ctx, actor } = await buildServiceContext({ cookies, request });
    if (!actor.user) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Sign in to update preferences.",
        401,
      );
    }

    const existingPrefs = readDateTimePrefs(actor.user.preferencesJson);
    const body = (await request.json().catch(() => null)) as Patch | null;
    const dateTimePatch = coerceDateTimePatch(body?.dateTime);
    if (!dateTimePatch) {
      return Response.json({ preferences: { dateTime: existingPrefs } });
    }
    const merged = { ...existingPrefs, ...dateTimePatch };
    const persisted = JSON.stringify({ dateTime: merged });
    const updated = await usersService.setPreferences(ctx, {
      userId: actor.user.id,
      preferencesJson: persisted,
    });
    return Response.json({
      preferences: {
        dateTime: readDateTimePrefs(updated.preferencesJson),
      },
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Preferences update failed.");
  }
};
