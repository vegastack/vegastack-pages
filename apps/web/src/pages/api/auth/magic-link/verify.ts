import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import {
  audit,
  auth,
  pages as pagesService,
  rateLimit,
  users,
  workspaces,
} from "@vegastack/pages-services";
import { publicSignupEnabled } from "../../../../lib/deployment";
import { parseSignupIntentRedirect } from "../../../../lib/signup-intents";
import { seedWorkspace, sha256Hex } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;

// Verify a magic-link token and complete sign-in. Writes go directly
// to D1 via the services layer, so no runtime-mutation lock or
// snapshot-persist round-trip is needed.
function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

async function completeMagicLinkVerification(input: {
  cookies: Parameters<APIRoute>[0]["cookies"];
  request: Request;
  token: string;
  url: URL;
}) {
  const token = input.token;
  if (!token)
    throw new AppError("AUTH_REQUIRED", "Magic link token is required.", 401);

  const { ctx } = await buildServiceContext({
    cookies: input.cookies,
    request: input.request,
  });
  // Defense-in-depth on top of the 32-byte token entropy: bound how many
  // verify attempts can come from one IP per minute. Token guessing is
  // already infeasible, but this bounds log-flood / enumeration DoS.
  await rateLimit.enforce(ctx, {
    key: `magic-link.verify:${clientIp(input.request) ?? "anonymous"}`,
    limit: 30,
    windowMs: 60_000,
  });
  const tokenHash = await sha256Hex(token);
  const magicLink = await auth.consumeMagicLink(ctx, { tokenHash });
  if (!magicLink) {
    throw new AppError(
      "AUTH_REQUIRED",
      "Magic link token is invalid or expired.",
      401,
    );
  }
  const signupIntent = parseSignupIntentRedirect(magicLink.redirectTo);
  let user = await users.getByEmail(ctx, magicLink.email);
  let redirectTo = magicLink.redirectTo || "/";

  if (signupIntent) {
    if (!publicSignupEnabled()) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Public signup is disabled on this instance.",
        403,
      );
    }
    user =
      user ??
      (await users.upsert(ctx, {
        email: magicLink.email,
        displayName: signupIntent.displayName || magicLink.email,
        role: "user",
      }));

    const existingWorkspaces = await workspaces.listForUser(ctx, {
      userId: user.id,
    });
    const existingWorkspace = existingWorkspaces[0] ?? null;
    // Create the workspace atomically with the admin membership row in
    // D1. workspaces.create auto-suffixes the slug on collisions so two
    // signups with the same workspace name still both succeed.
    const workspace =
      existingWorkspace ??
      (await workspaces.create(ctx, {
        name: signupIntent.workspaceName,
        firstAdminUserId: user.id,
      }));

    // seedWorkspace still consults the legacy in-memory state during the
    // clean-slate transition; mirror the new D1 row before invoking it
    // so the workspace lookup inside seedWorkspace succeeds.
    if (!existingWorkspace) {
    }
    const seeded = await seedWorkspace({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    if (!existingWorkspace) {
      const { ctx: workspaceCtx } = await buildServiceContext({
        cookies: input.cookies,
        request: input.request,
        workspaceId: workspace.id,
      });
      await audit.record(workspaceCtx, {
        workspaceId: workspace.id,
        actorUserId: user.id,
        action: "workspace.signup_created",
        targetType: "workspace",
        targetId: workspace.id,
        metadata: { source: "public_signup" },
      });
    }

    const { ctx: pageCtx } = await buildServiceContext({
      cookies: input.cookies,
      request: input.request,
      workspaceId: workspace.id,
    });
    const firstPages = await pagesService.list(pageCtx, workspace.id);
    const firstPage = firstPages[0];
    redirectTo = firstPage
      ? `/p/${firstPage.slugId}`
      : `/p/${seeded.firstPageSlugId}`;
  }

  if (!user) {
    throw new AppError(
      "AUTH_REQUIRED",
      "No invited user exists for this email.",
      401,
    );
  }
  // Invalidate any prior session so a new login replaces the old
  // cookie's authority. Without this, a leaked or stolen prior cookie
  // remains valid until natural expiry (30 days). Defensive against
  // minimal cookie mocks used in route-level unit tests.
  if (typeof input.cookies?.get === "function") {
    const existingCookieSessionId =
      input.cookies.get("vpg_session")?.value ?? null;
    if (existingCookieSessionId) {
      await auth.destroySession(ctx, existingCookieSessionId);
    }
  }
  const session = await auth.createSession(ctx, { userId: user.id });
  input.cookies.set("vpg_session", session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: input.url.protocol === "https:",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return redirectTo;
}

export const GET: APIRoute = async ({ cookies, redirect, request, url }) => {
  try {
    const redirectTo = await completeMagicLinkVerification({
      cookies,
      request,
      token: url.searchParams.get("token") ?? "",
      url,
    });
    return redirect(redirectTo);
  } catch (error) {
    return serviceErrorToResponse(error, "Magic link verification failed.");
  }
};

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    const body = (await request.json()) as { token?: unknown };
    const redirectTo = await completeMagicLinkVerification({
      cookies,
      request,
      token: String(body.token ?? ""),
      url,
    });
    return Response.json({ ok: true, redirect_to: redirectTo });
  } catch (error) {
    return serviceErrorToResponse(error, "Magic link verification failed.");
  }
};
