import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { jsonAppError } from "../../../lib/access";
import { publicSignupEnabled } from "../../../lib/deployment";
import { sendMagicLinkEmail } from "../../../lib/email";
import { magicLinkHandoffUrl } from "../../../lib/magic-link";
import { createSignupIntentRedirect } from "../../../lib/signup-intents";
import {
  authService,
  checkRateLimit,
  persistRuntimeState,
} from "../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
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

    await checkRateLimit({
      key: `signup:${email}`,
      limit: 4,
      windowMs: 30 * 60_000,
    });

    const redirectTo = createSignupIntentRedirect({
      displayName: displayName || email,
      workspaceName,
    });
    const magic = await authService.createMagicLink({
      email,
      redirectTo,
    });
    await persistRuntimeState();
    const verifyUrl = magicLinkHandoffUrl(url.origin, magic.rawToken);
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
    return jsonAppError(error, "Signup failed.");
  }
};
