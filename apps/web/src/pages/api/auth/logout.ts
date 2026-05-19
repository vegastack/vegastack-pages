import type { APIRoute } from "astro";
import { auth as authService } from "@vegastack/pages-services";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";

export const prerender = false;

async function clearSession(
  ctx: Awaited<ReturnType<typeof buildServiceContext>>["ctx"],
  cookies: Parameters<APIRoute>[0]["cookies"],
) {
  const session = cookies.get("vpg_session")?.value;
  if (session) await authService.destroySession(ctx, session);
  cookies.delete("vpg_session", { path: "/" });
}

export const GET: APIRoute = async () =>
  Response.json(
    {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Use POST to log out.",
      },
    },
    { status: 405 },
  );

export const POST: APIRoute = async ({ cookies, redirect, request }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    await clearSession(ctx, cookies);
    if ((request.headers.get("accept") ?? "").includes("text/html")) {
      return redirect("/app/login");
    }
    return Response.json({ ok: true });
  } catch (error) {
    return serviceErrorToResponse(error, "Logout failed.");
  }
};
