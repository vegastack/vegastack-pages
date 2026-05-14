import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMagicLinkEmail } from "./email";

afterEach(() => {
  delete process.env.VPG_EMAIL_PROVIDER;
  vi.restoreAllMocks();
});

describe("email delivery", () => {
  it("redacts magic-link tokens from console provider logs", async () => {
    process.env.VPG_EMAIL_PROVIDER = "console";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const token = "secret-token-value";

    await sendMagicLinkEmail({
      to: "reader@example.test",
      verifyUrl: `https://pages.example.test/auth/magic-link#token=${token}`,
      workspaceName: "Docs",
    });

    const logged = info.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain(token);
    expect(logged).toContain("token=%3Credacted%3E");
  });
});
