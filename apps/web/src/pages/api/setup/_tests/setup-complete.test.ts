import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../complete";

function requestFor(ip: string) {
  return new Request("https://pages.example.test/api/setup/complete", {
    method: "POST",
    headers: {
      "cf-connecting-ip": ip,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      setup_token: "wrong-token",
      admin_email: "admin@example.test",
      admin_name: "Admin",
      workspace_name: "Setup Workspace",
    }),
  });
}

afterEach(() => {
  delete process.env.VPG_SETUP_TOKEN;
});

describe("setup completion API", () => {
  it("rate-limits setup token attempts by client address", async () => {
    process.env.VPG_SETUP_TOKEN = `correct-${crypto.randomUUID()}`;
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const otherIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const cookies = { set: vi.fn() };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST({
        cookies,
        request: requestFor(ip),
      } as never);
      expect(response.status).toBe(403);
    }

    const limited = await POST({
      cookies,
      request: requestFor(ip),
    } as never);
    expect(limited.status).toBe(429);

    const differentClient = await POST({
      cookies,
      request: requestFor(otherIp),
    } as never);
    expect(differentClient.status).toBe(403);
  });
});
