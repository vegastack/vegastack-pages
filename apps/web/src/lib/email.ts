import { AppError } from "@vegastack/pages-core";
import { standaloneRadius } from "./radius-tokens";
import { getRuntimeBindings } from "./runtime";
import { standaloneEmailStyle, standalonePalette } from "./standalone-theme";

export type MagicLinkEmailInput = {
  to: string;
  verifyUrl: string;
  workspaceName?: string | null;
};

export type EmailDeliveryResult = {
  provider: "cloudflare" | "console";
  sent: boolean;
};

function emailProvider() {
  return (process.env.VPG_EMAIL_PROVIDER ?? "auto").toLowerCase();
}

function sender() {
  return {
    email: process.env.VPG_EMAIL_FROM ?? "",
    name: process.env.VPG_EMAIL_FROM_NAME ?? "VegaStack Pages",
  };
}

function subject(input: MagicLinkEmailInput) {
  return input.workspaceName
    ? `Sign in to ${input.workspaceName}`
    : "Sign in to VegaStack Pages";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function textBody(input: MagicLinkEmailInput) {
  return [
    "Use this secure link to sign in to VegaStack Pages:",
    "",
    input.verifyUrl,
    "",
    "This link expires soon. If you did not request it, ignore this email.",
  ].join("\n");
}

function htmlBody(input: MagicLinkEmailInput) {
  const safeUrl = escapeHtml(input.verifyUrl);
  const label = escapeHtml(
    input.workspaceName
      ? `Sign in to ${input.workspaceName}`
      : "Sign in to VegaStack Pages",
  );
  return `<!doctype html>
<html>
  <body style="margin:0;background:${standalonePalette.surfaceMuted};${standaloneEmailStyle.bodyFont};color:${standalonePalette.text};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${standalonePalette.surface};${standaloneEmailStyle.cardLine};border-radius:${standaloneRadius.card};padding:28px;">
            <tr><td style="${standaloneEmailStyle.title};">${label}</td></tr>
            <tr><td style="padding-top:14px;${standaloneEmailStyle.body};color:${standalonePalette.muted};">Use this secure magic link to continue. It expires soon.</td></tr>
            <tr><td style="padding-top:22px;"><a href="${safeUrl}" style="display:inline-block;background:${standalonePalette.accent};color:${standalonePalette.accentForeground};text-decoration:none;border-radius:${standaloneRadius.button};padding:11px 16px;${standaloneEmailStyle.action};">Open VegaStack Pages</a></td></tr>
            <tr><td style="padding-top:22px;${standaloneEmailStyle.url};color:${standalonePalette.muted};word-break:break-all;">${safeUrl}</td></tr>
            <tr><td style="padding-top:24px;${standaloneEmailStyle.finePrint};color:${standalonePalette.mutedFaint};">If you did not request this email, you can ignore it.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function encodeHeader(value: string) {
  return value.replaceAll("\r", "").replaceAll("\n", " ");
}

function rawMime(
  input: MagicLinkEmailInput,
  from: { email: string; name: string },
) {
  const boundary = `vpg-${crypto.randomUUID().replaceAll("-", "")}`;
  const fromHeader = from.name
    ? `"${encodeHeader(from.name).replaceAll('"', '\\"')}" <${from.email}>`
    : from.email;
  return [
    `From: ${fromHeader}`,
    `To: ${encodeHeader(input.to)}`,
    `Subject: ${encodeHeader(subject(input))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    textBody(input),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody(input),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function sendWithCloudflareBinding(
  input: MagicLinkEmailInput,
  from: { email: string; name: string },
) {
  const bindings = await getRuntimeBindings();
  if (!bindings?.EMAIL) {
    throw new AppError(
      "EMAIL_NOT_CONFIGURED",
      "Cloudflare Email Service binding EMAIL is not configured.",
      503,
    );
  }
  try {
    const specifier = "cloudflare:email";
    const module = await import(/* @vite-ignore */ specifier);
    const EmailMessage = (
      module as {
        EmailMessage?: new (from: string, to: string, raw: string) => unknown;
      }
    ).EmailMessage;
    if (EmailMessage) {
      await bindings.EMAIL.send(
        new EmailMessage(from.email, input.to, rawMime(input, from)),
      );
      return;
    }
  } catch {
    // Local development and older bindings may not expose cloudflare:email.
  }

  await bindings.EMAIL.send({
    to: input.to,
    from,
    subject: subject(input),
    text: textBody(input),
    html: htmlBody(input),
  });
}

export async function sendMagicLinkEmail(
  input: MagicLinkEmailInput,
): Promise<EmailDeliveryResult> {
  const provider = emailProvider();
  const bindings = await getRuntimeBindings();
  const from = sender();

  if (
    (provider === "auto" && bindings?.EMAIL) ||
    provider === "cloudflare" ||
    provider === "cloudflare_email_service"
  ) {
    if (!bindings?.EMAIL) {
      throw new AppError(
        "EMAIL_NOT_CONFIGURED",
        "Cloudflare Email Service binding EMAIL is not configured.",
        503,
      );
    }
    if (!from.email) {
      throw new AppError(
        "EMAIL_NOT_CONFIGURED",
        "VPG_EMAIL_FROM must be configured before sending email.",
        503,
      );
    }
    await sendWithCloudflareBinding(input, from);
    return { provider: "cloudflare", sent: true };
  }

  if (import.meta.env.DEV || provider === "console") {
    console.info(
      `[VegaStack Pages] Magic link for ${input.to}: ${redactMagicLinkUrl(input.verifyUrl)}`,
    );
    return { provider: "console", sent: false };
  }

  throw new AppError(
    "EMAIL_NOT_CONFIGURED",
    "Email delivery is not configured for this instance.",
    503,
  );
}

function redactMagicLinkUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "<redacted>");
    }
    const hash = new URLSearchParams(url.hash.slice(1));
    if (hash.has("token")) {
      hash.set("token", "<redacted>");
      url.hash = hash.toString();
    }
    return url.toString();
  } catch {
    return "<redacted>";
  }
}
