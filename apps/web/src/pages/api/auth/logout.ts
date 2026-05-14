import type { APIRoute } from "astro";
import { authService, persistRuntimeState } from "../../../lib/runtime";

export const prerender = false;

async function clearSession(cookies: Parameters<APIRoute>[0]["cookies"]) {
  const session = cookies.get("vpg_session")?.value;
  if (session) authService.destroySession(session);
  cookies.delete("vpg_session", { path: "/" });
  if (session) await persistRuntimeState();
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
  await clearSession(cookies);
  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    return redirect("/app/login");
  }
  return Response.json({ ok: true });
};
