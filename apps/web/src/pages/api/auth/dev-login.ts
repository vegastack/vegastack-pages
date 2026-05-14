import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  authService,
  ensureSeedData,
  persistRuntimeState,
  setupService,
  workspaceService,
} from "../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  if (!import.meta.env.DEV) {
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
      redirectTo: "/app",
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
    return redirect("/app");
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
