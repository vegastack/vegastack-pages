import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { auth, rateLimit } from "@vegastack/pages-services";
import { publicSignupEnabled } from "../../../lib/deployment";
import { sendMagicLinkEmail } from "../../../lib/email";
import { magicLinkHandoffUrl } from "../../../lib/magic-link";
import { createSignupIntentRedirect } from "../../../lib/signup-intents";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";
import { sha256Hex } from "../../../lib/runtime";
import { randomToken } from "../../../lib/oauth/codes";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!publicSignupEnabled()) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Public signup is disabled on this instance.",
        403,
      );
    }

    const body = await request.json();
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const displayName = String(
      body.display_name ?? body.displayName ?? "",
    ).trim();
    const workspaceName = String(
      body.workspace_name ?? body.workspaceName ?? "",
    ).trim();
    if (!workspaceName) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Workspace name is required.",
        400,
      );
    }

    const { ctx } = await buildServiceContext({ cookies, request });
    const rl = await rateLimit.check(ctx, {
      key: `signup:${email}`,
      limit: 10,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests. Try again later.",
        429,
        { reset_at: rl.resetAt },
      );
    }

    const redirectTo = createSignupIntentRedirect({
      displayName: displayName || email,
      workspaceName,
    });
    const rawToken = randomToken();
    const tokenHash = await sha256Hex(rawToken);
    await auth.createMagicLink(ctx, {
      email,
      tokenHash,
      redirectTo,
    });
    const verifyUrl = magicLinkHandoffUrl(url.origin, rawToken);
    const delivery = await sendMagicLinkEmail({
      to: email,
      verifyUrl,
      workspaceName,
    });
    const response: Record<string, unknown> = {
      ok: true,
      pending_verification: true,
      workspace_id: null,
      workspace_slug: null,
      redirect_to: null,
      delivery,
    };
    if (import.meta.env.DEV) {
      response.debug_verify_url = verifyUrl;
    }
    return Response.json(response);
  } catch (error) {
    return serviceErrorToResponse(error, "Signup failed.");
  }
};
