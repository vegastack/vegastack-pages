import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { auth, rateLimit, users, workspaces } from "@vegastack/pages-services";
import { safeLocalRedirectPath } from "../../../../lib/auth-redirects";
import { publicSignupEnabled } from "../../../../lib/deployment";
import { sendMagicLinkEmail } from "../../../../lib/email";
import { magicLinkHandoffUrl } from "../../../../lib/magic-link";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";
import { sha256Hex } from "../../../../lib/runtime";
import { randomToken } from "../../../../lib/oauth/codes";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    const body = await request.json();
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const { ctx } = await buildServiceContext({ cookies, request });
    const rl = await rateLimit.check(ctx, {
      key: `magic-link:${email}`,
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
    const user = await users.getByEmail(ctx, email);
    if (import.meta.env.DEV && !publicSignupEnabled() && !user) {
      throw new AppError(
        "AUTH_REQUIRED",
        "No local user exists for this email. Use the dev-only direct sign-in link, or run pnpm local:setup -- --email <email> after pnpm local:reset.",
        401,
      );
    }
    const rawToken = randomToken();
    const tokenHash = await sha256Hex(rawToken);
    await auth.createMagicLink(ctx, {
      email,
      tokenHash,
      redirectTo: safeLocalRedirectPath(
        body.redirect_to ? String(body.redirect_to) : null,
      ),
    });
    const verifyUrl = magicLinkHandoffUrl(url.origin, rawToken);
    const userWorkspaces = user
      ? await workspaces.listForUser(ctx, { userId: user.id })
      : [];
    const workspace = userWorkspaces[0] ?? null;
    const delivery = await sendMagicLinkEmail({
      to: email,
      verifyUrl,
      workspaceName: workspace?.name ?? null,
    });
    const response: Record<string, unknown> = { ok: true, delivery };
    if (import.meta.env.DEV) {
      response.debug_token = rawToken;
      response.debug_verify_url = verifyUrl;
    }
    return Response.json(response);
  } catch (error) {
    return serviceErrorToResponse(error, "Magic link request failed.");
  }
};
