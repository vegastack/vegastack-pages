import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { safeLocalRedirectPath } from "../../../lib/auth-redirects";
import {
  authService,
  ensureSeedData,
  persistRuntimeState,
  setupService,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

function localDiagnosticLoginEnabled() {
  return (
    process.env.VPG_ENABLE_DEV_LOGIN === "true" &&
    process.env.VPG_ADAPTER === "node" &&
    process.env.VPG_RUNTIME === "node" &&
    process.env.VPG_PROD_DATA_DEV !== "true"
  );
}

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  if (!import.meta.env.DEV && !localDiagnosticLoginEnabled()) {
    return Response.json(
      {
        error: {
          code: "AUTH_REQUIRED",
          message: "Development login is disabled.",
        },
      },
      { status: 404 },
    );
  }

  try {
    await ensureSeedData();
    const requestedEmail = url.searchParams.get("email");
    const requestedRedirect = url.searchParams.get("redirect_to") ?? "/app";
    const safeRedirect = safeLocalRedirectPath(requestedRedirect);
    const setup = setupService.status();
    const user = requestedEmail
      ? workspaceService.getUserByEmail(requestedEmail)
      : setup.firstAdminUserId
        ? workspaceService.getUser(setup.firstAdminUserId)
        : workspaceService.getUserByEmail(
            process.env.VPG_LOCAL_ADMIN_EMAIL ?? "dev@example.com",
          );
    if (!user) throw new AppError("AUTH_REQUIRED", "User was not found.", 401);
    const magic = await authService.createMagicLink({
      email: user.email,
      redirectTo: safeRedirect,
    });
    const session = await authService.consumeMagicLink(magic.rawToken, user.id);
    await persistRuntimeState();
    cookies.set("vpg_session", session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return redirect(safeRedirect);
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(error.toJSON(), { status: error.status });
    return Response.json(
      {
        error: { code: "INTERNAL_ERROR", message: "Development login failed." },
      },
      { status: 500 },
    );
  }
};
