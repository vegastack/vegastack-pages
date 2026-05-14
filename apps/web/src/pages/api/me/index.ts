import { AppError, type UserRecord } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../lib/access";
import {
  auditService,
  ensureSeedData,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

// Display names share a normalization shape with the rest of the app: leading
// and trailing whitespace stripped, single visible character minimum, and a
// generous upper bound so people can include titles or honorifics. Anything
// stricter belongs in client-side validation, not here.
const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 80;

function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppError(
      "VALIDATION_ERROR",
      "display_name must be a string.",
      400,
    );
  }
  // Collapse internal whitespace to a single space so "Local   Admin" round-trips
  // to "Local Admin" the same way the signup form does.
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length < DISPLAY_NAME_MIN) {
    throw new AppError(
      "VALIDATION_ERROR",
      "display_name cannot be empty.",
      400,
    );
  }
  if (trimmed.length > DISPLAY_NAME_MAX) {
    throw new AppError(
      "VALIDATION_ERROR",
      `display_name must be ${DISPLAY_NAME_MAX} characters or fewer.`,
      400,
    );
  }
  return trimmed;
}

function publicUserShape(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

export const GET: APIRoute = async ({ cookies, request }) => {
  try {
    await ensureSeedData();
    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Sign-in required.", 401);
    }
    return Response.json({ user: publicUserShape(actor.user) });
  } catch (error) {
    return jsonAppError(error, "Failed to load or update the current user.");
  }
};

export const PATCH: APIRoute = async ({ cookies, request }) => {
  try {
    await ensureSeedData();
    const actor = await getApiRequestActor(cookies, request);
    if (!actor.user) {
      throw new AppError("AUTH_REQUIRED", "Sign-in required.", 401);
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object") {
      throw new AppError(
        "VALIDATION_ERROR",
        "Request body must be a JSON object.",
        400,
      );
    }

    // Email is intentionally not editable here. Changing email requires a
    // verification round-trip (token to the new address, notification to the
    // old address) which is a separate flow; rejecting the field early
    // surfaces the design choice instead of silently dropping it.
    if (Object.prototype.hasOwnProperty.call(body, "email")) {
      throw new AppError(
        "VALIDATION_ERROR",
        "email cannot be changed from this endpoint. Email change requires a verified flow.",
        400,
      );
    }

    if (!Object.prototype.hasOwnProperty.call(body, "display_name")) {
      throw new AppError("VALIDATION_ERROR", "display_name is required.", 400);
    }

    const previousDisplayName = actor.user.displayName;
    const nextDisplayName = normalizeDisplayName(body.display_name);

    // No-op when the value hasn't actually changed. Avoid an audit log entry
    // and an unnecessary write so the activity feed stays meaningful.
    if (nextDisplayName === previousDisplayName) {
      return Response.json({
        user: publicUserShape(actor.user),
        changed: false,
      });
    }

    const updated = workspaceService.updateUser({
      userId: actor.user.id,
      displayName: nextDisplayName,
    });

    // Profile changes are audited at the user level. There's no workspace
    // scope on this action, so the activity surfaces in every workspace the
    // user belongs to via the user_id filter.
    auditService.record({
      workspaceId: null,
      actorUserId: actor.user.id,
      action: "profile.display_name_changed",
      targetType: "user",
      targetId: actor.user.id,
      metadata: {
        from: previousDisplayName,
        to: nextDisplayName,
      },
    });

    return Response.json({ user: publicUserShape(updated), changed: true });
  } catch (error) {
    return jsonAppError(error, "Failed to load or update the current user.");
  }
};
