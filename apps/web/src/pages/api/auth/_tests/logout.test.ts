import { describe, expect, it, vi } from "vitest";
import { authService } from "../../../../lib/runtime";
import { GET, POST } from "../logout";

function cookiesFor(sessionId: string) {
  return {
    get(name: string) {
      return name === "vpg_session" ? { value: sessionId } : undefined;
    },
    delete: vi.fn(),
  };
}

describe("logout API", () => {
  it("does not destroy sessions on GET", async () => {
    const session = authService.createSession("usr_logout_get");
    const cookies = cookiesFor(session.id);

    const response = await GET({ cookies: cookies as never } as never);

    expect(response.status).toBe(405);
    expect(authService.getSession(session.id)).not.toBeNull();
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it("destroys sessions only on POST", async () => {
    const session = authService.createSession("usr_logout_post");
    const cookies = cookiesFor(session.id);

    const response = await POST({
      cookies: cookies as never,
      request: new Request("https://pages.example.test/api/auth/logout", {
        method: "POST",
      }),
      redirect: (location: string) =>
        new Response(null, { status: 302, headers: { location } }),
    } as never);

    expect(response.status).toBe(200);
    expect(authService.getSession(session.id)).toBeNull();
    expect(cookies.delete).toHaveBeenCalledWith("vpg_session", { path: "/" });
  });
});
