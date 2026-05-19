import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { publications, rateLimit } from "@vegastack/pages-services";
import {
  assertApiWorkspaceId,
  jsonAppError,
  publicationPasswordCookieName,
  publicationPasswordCookieValue,
} from "../../../../lib/access";
import { buildServiceContext } from "../../../../lib/service-context";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const publicationId = params.publicationId ?? "";
    const { ctx } = await buildServiceContext({ cookies, request });
    const publication = await publications.get(ctx, publicationId);
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
    await rateLimit.check(ctx, {
      key: `publication-password:${publicationId}`,
      limit: 10,
      windowMs: 60_000,
    });
    const verified = await publications.verifyPassword(ctx, {
      publicationId,
      password,
    });
    if (!verified) {
      throw new AppError(
        "PUBLICATION_PASSWORD_INVALID",
        "The provided password is incorrect.",
        401,
      );
    }
    cookies.set(
      publicationPasswordCookieName(publication.id),
      await publicationPasswordCookieValue(publication),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: url.protocol === "https:",
        path: "/",
        expires: publication.expiresAt
          ? new Date(publication.expiresAt)
          : new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    );
    return Response.json({
      publication_id: publication.id,
      permission: publication.permission,
      expires_at: publication.expiresAt,
    });
  } catch (error) {
    return jsonAppError(error, "Publication password verification failed.");
  }
};
