import { describe, expect, it } from "vitest";
import { authService, workspaceService } from "../../../lib/runtime";
import { GET as getMe, PATCH as patchMe } from "../me/index";

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function sessionCookies(sessionId: string | null) {
  return {
    get(name: string) {
      if (name === "vpg_session" && sessionId) return { value: sessionId };
      return undefined;
    },
  } as never;
}

function jsonRequest(body: unknown, init: { method?: string } = {}) {
  return new Request("https://pages.example.test/api/me", {
    method: init.method ?? "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedUser(displayName = "Original Name") {
  const user = workspaceService.createUser({
    id: uniqueId("usr"),
    email: `me-test-${crypto.randomUUID()}@example.test`,
    displayName,
  });
  const session = authService.createSession(user.id);
  return { user, sessionId: session.id };
}

describe("/api/me", () => {
  describe("GET", () => {
    it("returns the current user shape with normalized field names", async () => {
      const { user, sessionId } = await seedUser("Get Test User");
      const response = await getMe({
        cookies: sessionCookies(sessionId),
        request: new Request("https://pages.example.test/api/me"),
      } as never);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        user: { id: string; email: string; display_name: string };
      };
      expect(body.user.id).toBe(user.id);
      expect(body.user.email).toBe(user.email);
      expect(body.user.display_name).toBe("Get Test User");
    });

    it("returns 401 when unauthenticated", async () => {
      const response = await getMe({
        cookies: sessionCookies(null),
        request: new Request("https://pages.example.test/api/me"),
      } as never);
      expect(response.status).toBe(401);
    });
  });

  describe("PATCH", () => {
    it("updates display_name and trims whitespace", async () => {
      const { user, sessionId } = await seedUser("Before");
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({ display_name: "  After   The   Edit  " }),
      } as never);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        user: { display_name: string };
        changed: boolean;
      };
      // Trims surrounding whitespace AND collapses interior whitespace runs.
      expect(body.user.display_name).toBe("After The Edit");
      expect(body.changed).toBe(true);

      // Service state reflects the update so subsequent requests see it.
      const reloaded = workspaceService.getUser(user.id);
      expect(reloaded?.displayName).toBe("After The Edit");
    });

    it("returns changed=false when the value is unchanged (no audit log)", async () => {
      const { sessionId } = await seedUser("Same Name");
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({ display_name: "Same Name" }),
      } as never);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { changed: boolean };
      expect(body.changed).toBe(false);
    });

    it("rejects empty display_name", async () => {
      const { sessionId } = await seedUser();
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({ display_name: "   " }),
      } as never);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message.toLowerCase()).toContain("empty");
    });

    it("rejects display_name longer than 80 characters", async () => {
      const { sessionId } = await seedUser();
      const tooLong = "x".repeat(81);
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({ display_name: tooLong }),
      } as never);
      expect(response.status).toBe(400);
    });

    it("rejects non-string display_name", async () => {
      const { sessionId } = await seedUser();
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({ display_name: 123 }),
      } as never);
      expect(response.status).toBe(400);
    });

    it("requires display_name in the body", async () => {
      const { sessionId } = await seedUser();
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({}),
      } as never);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message.toLowerCase()).toContain("display_name");
    });

    it("explicitly rejects an email change attempt with a clear error", async () => {
      const { sessionId } = await seedUser();
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: jsonRequest({
          display_name: "Whatever",
          email: "new@example.test",
        }),
      } as never);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message.toLowerCase()).toContain("email");
      expect(body.error.message.toLowerCase()).toContain("verified flow");
    });

    it("returns 401 when unauthenticated", async () => {
      const response = await patchMe({
        cookies: sessionCookies(null),
        request: jsonRequest({ display_name: "Anything" }),
      } as never);
      expect(response.status).toBe(401);
    });

    it("rejects an entirely non-JSON / invalid body", async () => {
      const { sessionId } = await seedUser();
      const response = await patchMe({
        cookies: sessionCookies(sessionId),
        request: new Request("https://pages.example.test/api/me", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "not-json",
        }),
      } as never);
      expect(response.status).toBe(400);
    });
  });
});
