import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { publicSignupEnabled } from "../../../../lib/deployment";
import {
  createUniqueWorkspace,
  parseSignupIntentRedirect,
} from "../../../../lib/signup-intents";
import {
  acquireRuntimeMutationLock,
  auditService,
  authService,
  ensureSeedData,
  pageService,
  persistRuntimeState,
  refreshRuntimeState,
  seedWorkspace,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

async function completeMagicLinkVerification(input: {
  cookies: Parameters<APIRoute>[0]["cookies"];
  token: string;
  url: URL;
}) {
  let lock: Awaited<ReturnType<typeof acquireRuntimeMutationLock>> | null =
    null;
  try {
    lock = await acquireRuntimeMutationLock();
    await refreshRuntimeState();
    if (!publicSignupEnabled()) {
      await ensureSeedData();
    }
    const token = input.token;
    if (!token)
      throw new AppError("AUTH_REQUIRED", "Magic link token is required.", 401);
    const magicLink = await authService.verifyMagicLink(token);
    const signupIntent = parseSignupIntentRedirect(magicLink.redirectTo);
    let user = workspaceService.getUserByEmail(magicLink.email);
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
        workspaceService.createUser({
          email: magicLink.email,
          displayName: signupIntent.displayName || magicLink.email,
          role: "user",
        });

      const existingWorkspace =
        workspaceService.listWorkspacesForUser(user.id)[0] ?? null;
      const workspace =
        existingWorkspace ?? createUniqueWorkspace(signupIntent.workspaceName);
      if (!existingWorkspace) {
        workspaceService.addMember({
          workspaceId: workspace.id,
          userId: user.id,
          role: "admin",
        });
      }

      const seeded = await seedWorkspace({
        workspaceId: workspace.id,
        actorUserId: user.id,
      });
      if (!existingWorkspace) {
        auditService.record({
          workspaceId: workspace.id,
          actorUserId: user.id,
          action: "workspace.signup_created",
          targetType: "workspace",
          targetId: workspace.id,
          metadata: { source: "public_signup" },
        });
      }

      const firstPage = pageService.listPages(workspace.id)[0];
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
    const session = await authService.consumeMagicLink(token, user.id);
    await persistRuntimeState();
    input.cookies.set("vpg_session", session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: input.url.protocol === "https:",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return redirectTo;
  } finally {
    await lock?.release();
  }
}

function magicLinkError(error: unknown) {
  if (error instanceof AppError)
    return Response.json(error.toJSON(), { status: error.status });
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Magic link verification failed.",
      },
    },
    { status: 500 },
  );
}

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  try {
    const redirectTo = await completeMagicLinkVerification({
      cookies,
      token: url.searchParams.get("token") ?? "",
      url,
    });
    return redirect(redirectTo);
  } catch (error) {
    return magicLinkError(error);
  }
};

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    const body = (await request.json()) as { token?: unknown };
    const redirectTo = await completeMagicLinkVerification({
      cookies,
      token: String(body.token ?? ""),
      url,
    });
    return Response.json({ ok: true, redirect_to: redirectTo });
  } catch (error) {
    return magicLinkError(error);
  }
};
