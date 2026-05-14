import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { safeLocalRedirectPath } from "../../../../lib/auth-redirects";
import { publicSignupEnabled } from "../../../../lib/deployment";
import { sendMagicLinkEmail } from "../../../../lib/email";
import { magicLinkHandoffUrl } from "../../../../lib/magic-link";
import {
  authService,
  checkRateLimit,
  ensureSeedData,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  try {
    if (!publicSignupEnabled()) {
      await ensureSeedData();
    }
    const body = await request.json();
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    await checkRateLimit({
      key: `magic-link:${email}`,
      limit: 5,
      windowMs: 15 * 60_000,
    });
    const user = workspaceService.getUserByEmail(email);
    if (import.meta.env.DEV && !publicSignupEnabled() && !user) {
      throw new AppError(
        "AUTH_REQUIRED",
        "No local user exists for this email. Use the dev-only direct sign-in link, or run pnpm local:setup -- --email <email> after pnpm local:reset.",
        401,
      );
    }
    const created = await authService.createMagicLink({
      email,
      redirectTo: safeLocalRedirectPath(
        body.redirect_to ? String(body.redirect_to) : null,
      ),
    });
    const verifyUrl = magicLinkHandoffUrl(url.origin, created.rawToken);
    const workspace = user
      ? workspaceService.listWorkspacesForUser(user.id)[0]
      : null;
    const delivery = await sendMagicLinkEmail({
      to: email,
      verifyUrl,
      workspaceName: workspace?.name ?? null,
    });
    const response: Record<string, unknown> = { ok: true, delivery };
    if (import.meta.env.DEV) {
      response.debug_token = created.rawToken;
      response.debug_verify_url = verifyUrl;
    }
    return Response.json(response);
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(error.toJSON(), { status: error.status });
    return Response.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Magic link request failed.",
        },
      },
      { status: 500 },
    );
  }
};
