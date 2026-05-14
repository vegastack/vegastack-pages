import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMagicLinkEmail } from "./email";

afterEach(() => {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_REGION;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.VPG_EMAIL_FROM;
  delete process.env.VPG_EMAIL_FROM_NAME;
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

  it("sends magic links through AWS SES with a signed raw MIME request", async () => {
    process.env.VPG_EMAIL_PROVIDER = "ses";
    process.env.VPG_EMAIL_FROM = "pages@example.test";
    process.env.VPG_EMAIL_FROM_NAME = "Example Pages";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<SendRawEmailResponse />"));

    const result = await sendMagicLinkEmail({
      to: "reader@example.test",
      verifyUrl: "https://pages.example.test/auth/magic-link#token=secret",
      workspaceName: "Docs",
    });

    expect(result).toEqual({ provider: "ses", sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://email.us-east-1.amazonaws.com/");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(headers.get("authorization")).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/",
    );
    expect(headers.get("authorization")).not.toContain(
      process.env.AWS_SECRET_ACCESS_KEY,
    );
    expect(headers.get("x-amz-content-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("Action")).toBe("SendRawEmail");
    expect(body.get("Version")).toBe("2010-12-01");
    expect(body.get("Source")).toBe("pages@example.test");
    const raw = Buffer.from(
      body.get("RawMessage.Data") ?? "",
      "base64",
    ).toString("utf8");
    expect(raw).toContain('From: "Example Pages" <pages@example.test>');
    expect(raw).toContain("To: reader@example.test");
    expect(raw).toContain("Subject: Sign in to Docs");
    expect(raw).toContain(
      "https://pages.example.test/auth/magic-link#token=secret",
    );
  });

  it("supports the aws_ses provider alias", async () => {
    process.env.VPG_EMAIL_PROVIDER = "aws_ses";
    process.env.VPG_EMAIL_FROM = "pages@example.test";
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<SendRawEmailResponse />"),
    );

    await expect(
      sendMagicLinkEmail({
        to: "reader@example.test",
        verifyUrl: "https://pages.example.test/auth/magic-link#token=secret",
      }),
    ).resolves.toEqual({ provider: "ses", sent: true });
  });

  it("fails closed when AWS SES secrets or sender config are missing", async () => {
    process.env.VPG_EMAIL_PROVIDER = "ses";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      sendMagicLinkEmail({
        to: "reader@example.test",
        verifyUrl: "https://pages.example.test/auth/magic-link#token=secret",
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_NOT_CONFIGURED",
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts long SES error payload values before surfacing delivery failures", async () => {
    process.env.VPG_EMAIL_PROVIDER = "ses";
    process.env.VPG_EMAIL_FROM = "pages@example.test";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY =
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<Error><Message>Bad key AKIAIOSFODNN7EXAMPLE and token abcdefghijklmnopqrstuvwxyz1234567890</Message></Error>",
        { status: 403 },
      ),
    );

    await expect(
      sendMagicLinkEmail({
        to: "reader@example.test",
        verifyUrl: "https://pages.example.test/auth/magic-link#token=secret",
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
      details: { provider: "ses", status: 403 },
      message: "Bad key <redacted-access-key> and token <redacted>",
      status: 502,
    });
  });
});
