import { describe, expect, it, vi } from "vitest";
import { auth, users } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { GET, POST } from "../logout";

function cookiesFor(sessionId: string) {
  return {
    get(name: string) {
      return name === "vpg_session" ? { value: sessionId } : undefined;
    },
    delete: vi.fn(),
  };
}

async function makeUserAndSession(userId: string) {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  await users.upsert(ctx, {
    id: userId,
    email: `${userId}@example.test`,
    displayName: `Test ${userId}`,
    role: "user",
  });
  const session = await auth.createSession(ctx, { userId });
  return { ctx, session };
}

describe("logout API", () => {
  it("does not destroy sessions on GET", async () => {
    const { ctx, session } = await makeUserAndSession("usr_logout_get_d1");
    const cookies = cookiesFor(session.id);

    const response = await GET({ cookies: cookies as never } as never);

    expect(response.status).toBe(405);
    const stillThere = await auth.getSession(ctx, session.id);
    expect(stillThere).not.toBeNull();
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it("destroys sessions only on POST", async () => {
    const { ctx, session } = await makeUserAndSession("usr_logout_post_d1");
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
    const destroyed = await auth.getSession(ctx, session.id);
    expect(destroyed).toBeNull();
    expect(cookies.delete).toHaveBeenCalledWith("vpg_session", { path: "/" });
  });
});
