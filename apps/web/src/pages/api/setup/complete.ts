import { AppError, slugifyTitle } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  auth,
  rateLimit,
  setup,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { clientRateLimitKey } from "../../../lib/client-address";
import { seedWorkspace } from "../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";

export const prerender = false;

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export const POST: APIRoute = async ({ cookies, request }) => {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await request.json()
      : Object.fromEntries((await request.formData()).entries());
    const expectedSetupToken =
      process.env.VPG_SETUP_TOKEN ??
      (import.meta.env.DEV ? "dev-setup-token" : "");

    const { ctx } = await buildServiceContext({ cookies, request });

    if ((await setup.status(ctx)).setupComplete) {
      throw new AppError(
        "SETUP_ALREADY_COMPLETE",
        "Setup has already been completed.",
        409,
      );
    }
    if (!expectedSetupToken) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Setup token is not configured for this deployment.",
        403,
      );
    }
    const rl = await rateLimit.check(ctx, {
      key: clientRateLimitKey(request, "setup-complete"),
      limit: 5,
      windowMs: 15 * 60_000,
    });
    if (!rl.ok) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        { reset_at: rl.resetAt },
      );
    }
    if (
      !constantTimeEqual(String(body.setup_token ?? ""), expectedSetupToken)
    ) {
      throw new AppError("PERMISSION_DENIED", "Invalid setup token.", 403);
    }

    const adminEmail = String(body.admin_email ?? "");
    const adminName = String(body.admin_name ?? "");
    const workspaceName = String(body.workspace_name ?? "");

    const admin = await users.upsert(ctx, {
      email: adminEmail,
      displayName: adminName,
      role: "instance_admin",
    });
    const workspace = await workspaces.create(ctx, {
      name: workspaceName,
      slug: slugifyTitle(workspaceName),
      firstAdminUserId: admin.id,
    });
    const seeded = await seedWorkspace({
      workspaceId: workspace.id,
      actorUserId: admin.id,
    });

    // Re-check setupComplete immediately before the flip. Without this,
    // a setup POST that lost a race to a concurrent setup POST would
    // create a SECOND admin + SECOND workspace before failing on the
    // setup-flag flip — leaving orphan rows. Re-reading the flag right
    // before `complete()` shrinks that race window to the synchronous
    // setup.complete() call itself.
    if ((await setup.status(ctx)).setupComplete) {
      throw new AppError(
        "SETUP_ALREADY_COMPLETE",
        "Setup completed by a concurrent request.",
        409,
      );
    }

    const result = await setup.complete(ctx, {
      setupToken: String(body.setup_token ?? ""),
      expectedSetupToken,
      adminEmail,
      adminName,
      workspaceName,
      adminUserId: admin.id,
      workspaceId: workspace.id,
    });
    const session = await auth.createSession(ctx, { userId: admin.id });
    // Invalidate any prior session cookie so first-run setup replaces
    // (rather than supplements) whatever was there. Defensive against
    // minimal cookie mocks used in route-level unit tests.
    if (typeof cookies?.get === "function") {
      const previous = cookies.get("vpg_session")?.value ?? null;
      if (previous && previous !== session.id) {
        await auth.destroySession(ctx, previous);
      }
    }
    cookies.set("vpg_session", session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: !import.meta.env.DEV,
      expires: new Date(session.expiresAt),
    });
    const redirectTo = `/p/${seeded.firstPageSlugId}`;

    if (!contentType.includes("application/json")) {
      return new Response(null, {
        status: 303,
        headers: { Location: redirectTo },
      });
    }

    return Response.json({
      user_id: result.adminUserId,
      workspace_id: result.workspaceId,
      redirect_to: redirectTo,
      ...result,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Setup failed.");
  }
};
