import type { APIRoute } from "astro";
import {
  assertApiWorkspaceId,
  jsonAppError,
  publicationPasswordCookieName,
  publicationPasswordCookieValue,
} from "../../../../lib/access";
import {
  ensureSeedData,
  publicationService,
  rateLimiter,
} from "../../../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    await ensureSeedData();
    const publicationId = params.publicationId ?? "";
    const publication = publicationService.get(publicationId);
    if (!publication) {
      return Response.json(
        {
          error: {
            code: "PUBLICATION_NOT_FOUND",
            message: "Publication was not found.",
          },
        },
        { status: 404 },
      );
    }
    assertApiWorkspaceId({ url, workspaceId: publication.workspaceId });
    const body = await request.json().catch(() => ({}));
    const password = typeof body.password === "string" ? body.password : "";
    rateLimiter.check({
      key: `publication-password:${publicationId}`,
      limit: 10,
      windowMs: 60_000,
    });
    const verified = await publicationService.verifyPassword(
      publicationId,
      password,
    );
    cookies.set(
      publicationPasswordCookieName(verified.id),
      await publicationPasswordCookieValue(verified),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: url.protocol === "https:",
        path: "/",
        expires: verified.expiresAt
          ? new Date(verified.expiresAt)
          : new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    );
    return Response.json({
      publication_id: verified.id,
      permission: verified.permission,
      expires_at: verified.expiresAt,
    });
  } catch (error) {
    return jsonAppError(error, "Publication password verification failed.");
  }
};
