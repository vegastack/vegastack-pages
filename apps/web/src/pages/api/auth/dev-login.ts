import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { auth, rateLimit, setup, users } from "@vegastack/pages-services";
import { safeLocalRedirectPath } from "../../../lib/auth-redirects";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";
import { sha256Hex } from "../../../lib/runtime";
import { randomToken } from "../../../lib/oauth/codes";

export const prerender = false;

function localDiagnosticLoginEnabled() {
  return (
    process.env.VPG_ENABLE_DEV_LOGIN === "true" &&
    process.env.VPG_RUNTIME === "node" &&
    process.env.VPG_PROD_DATA_DEV !== "true"
  );
}

export const GET: APIRoute = async ({ cookies, redirect, request, url }) => {
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
    const { ctx } = await buildServiceContext({ cookies, request });
    // Belt-and-braces rate limit. The endpoint is already DEV-only +
    // env-flag gated, but a misconfigured prod (`VPG_ENABLE_DEV_LOGIN=true`)
    // would expose unthrottled impersonation. 20/hour per requested
    // email keeps brute-force enumeration slow even in that scenario.
    const rl = await rateLimit.check(ctx, {
      key: `dev-login:email:${url.searchParams.get("email") ?? "default"}`,
      limit: 20,
      windowMs: 60 * 60_000,
    });
    if (!rl.ok) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        { reset_at: rl.resetAt },
      );
    }

    const requestedEmail = url.searchParams.get("email");
    const requestedRedirect = url.searchParams.get("redirect_to") ?? "/app";
    const safeRedirect = safeLocalRedirectPath(requestedRedirect);
    const setupStatus = await setup.status(ctx);
    const user = requestedEmail
      ? await users.getByEmail(ctx, requestedEmail)
      : setupStatus.firstAdminUserId
        ? await users.getById(ctx, setupStatus.firstAdminUserId)
        : await users.getByEmail(
            ctx,
            process.env.VPG_LOCAL_ADMIN_EMAIL ?? "dev@example.com",
          );
    if (!user) throw new AppError("AUTH_REQUIRED", "User was not found.", 401);

    const rawToken = randomToken();
    const tokenHash = await sha256Hex(rawToken);
    await auth.createMagicLink(ctx, {
      email: user.email,
      tokenHash,
      redirectTo: safeRedirect,
    });
    const consumed = await auth.consumeMagicLink(ctx, { tokenHash });
    if (!consumed) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Magic link could not be consumed.",
        401,
      );
    }
    const session = await auth.createSession(ctx, { userId: user.id });

    // Invalidate any prior session cookie so a fresh dev-login replaces
    // (rather than supplements) the previous authority. Defensive
    // against route-level unit tests that pass minimal cookie mocks.
    if (typeof cookies?.get === "function") {
      const previous = cookies.get("vpg_session")?.value ?? null;
      if (previous && previous !== session.id) {
        await auth.destroySession(ctx, previous);
      }
    }
    cookies.set("vpg_session", session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return redirect(safeRedirect);
  } catch (error) {
    return serviceErrorToResponse(error, "Development login failed.");
  }
};
