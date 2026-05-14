import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { clientRateLimitKey } from "../../../lib/client-address";
import {
  authService,
  checkRateLimit,
  seedWorkspace,
  setupService,
  workspaceService,
} from "../../../lib/runtime";

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
    if (setupService.status().setupComplete) {
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
    await checkRateLimit({
      key: clientRateLimitKey(request, "setup-complete"),
      limit: 5,
      windowMs: 15 * 60_000,
    });
    if (
      !constantTimeEqual(String(body.setup_token ?? ""), expectedSetupToken)
    ) {
      throw new AppError("PERMISSION_DENIED", "Invalid setup token.", 403);
    }

    const admin = workspaceService.createUser({
      email: String(body.admin_email ?? ""),
      displayName: String(body.admin_name ?? ""),
      role: "instance_admin",
    });
    const workspace = workspaceService.createWorkspace({
      name: String(body.workspace_name ?? ""),
    });
    workspaceService.addMember({
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
    });
    const seeded = await seedWorkspace({
      workspaceId: workspace.id,
      actorUserId: admin.id,
    });

    const result = setupService.complete({
      setupToken: String(body.setup_token ?? ""),
      expectedSetupToken,
      adminEmail: String(body.admin_email ?? ""),
      adminName: String(body.admin_name ?? ""),
      workspaceName: String(body.workspace_name ?? ""),
      adminUserId: admin.id,
      workspaceId: workspace.id,
    });
    const session = authService.createSession(admin.id);
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
    if (error instanceof AppError) {
      return Response.json(error.toJSON(), { status: error.status });
    }
    console.error("[VegaStack Pages] Setup failed.", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Setup failed." } },
      { status: 500 },
    );
  }
};
