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
  provider: "cloudflare" | "console" | "ses";
  sent: boolean;
};

type RuntimeEmailBindings = Awaited<ReturnType<typeof getRuntimeBindings>>;

type EmailSender = {
  email: string;
  name: string;
};

type AwsSesConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

function bindingValue(bindings: RuntimeEmailBindings, name: string) {
  const value = (bindings as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : undefined;
}

function configValue(
  bindings: RuntimeEmailBindings,
  name: string,
  fallback = "",
) {
  return process.env[name] ?? bindingValue(bindings, name) ?? fallback;
}

function emailProvider(bindings: RuntimeEmailBindings) {
  return configValue(bindings, "VPG_EMAIL_PROVIDER", "auto").toLowerCase();
}

function sender(bindings: RuntimeEmailBindings): EmailSender {
  return {
    email: configValue(bindings, "VPG_EMAIL_FROM"),
    name: configValue(bindings, "VPG_EMAIL_FROM_NAME", "VegaStack Pages"),
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

function rawMime(input: MagicLinkEmailInput, from: EmailSender) {
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
  from: EmailSender,
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

function bytesToHex(bytes: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(digest);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, value: string) {
  const keyBytes =
    key instanceof ArrayBuffer ? key : Uint8Array.from(key).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function awsSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
) {
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${secretAccessKey}`),
    date,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "ses");
  return hmacSha256(kService, "aws4_request");
}

function awsTimestamp(date = new Date()) {
  const iso = date.toISOString().replaceAll(/[:-]|\.\d{3}/g, "");
  return {
    date: iso.slice(0, 8),
    datetime: iso,
  };
}

function base64Utf8(value: string) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sesErrorMessage(responseText: string) {
  const match = /<Message>([^<]+)<\/Message>/.exec(responseText);
  if (!match?.[1]) return "AWS SES rejected the email send.";
  return match[1]
    .replaceAll(/AKIA[0-9A-Z]{16}/g, "<redacted-access-key>")
    .replaceAll(/[A-Za-z0-9/+=]{32,}/g, "<redacted>");
}

function awsSesConfig(bindings: RuntimeEmailBindings): AwsSesConfig {
  return {
    region: configValue(bindings, "AWS_REGION"),
    accessKeyId: configValue(bindings, "AWS_ACCESS_KEY_ID"),
    secretAccessKey: configValue(bindings, "AWS_SECRET_ACCESS_KEY"),
    sessionToken: configValue(bindings, "AWS_SESSION_TOKEN"),
  };
}

function assertSesConfigured(config: AwsSesConfig, from: EmailSender) {
  const missing = [
    !config.region && "AWS_REGION",
    !config.accessKeyId && "AWS_ACCESS_KEY_ID",
    !config.secretAccessKey && "AWS_SECRET_ACCESS_KEY",
    !from.email && "VPG_EMAIL_FROM",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new AppError(
      "EMAIL_NOT_CONFIGURED",
      `AWS SES email delivery is missing: ${missing.join(", ")}.`,
      503,
    );
  }
}

async function sendWithAwsSes(
  input: MagicLinkEmailInput,
  from: EmailSender,
  config: AwsSesConfig,
) {
  assertSesConfigured(config, from);
  const endpoint = `https://email.${config.region}.amazonaws.com/`;
  const host = `email.${config.region}.amazonaws.com`;
  const payload = new URLSearchParams({
    Action: "SendRawEmail",
    Version: "2010-12-01",
    Source: from.email,
    "RawMessage.Data": base64Utf8(rawMime(input, from)),
  }).toString();
  const payloadHash = await sha256Hex(payload);
  const timestamp = awsTimestamp();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp.datetime,
  };
  if (config.sessionToken) {
    headers["x-amz-security-token"] = config.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}`)
    .join("\n");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${timestamp.date}/${config.region}/ses/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp.datetime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = bytesToHex(
    await hmacSha256(
      await awsSigningKey(
        config.secretAccessKey,
        timestamp.date,
        config.region,
      ),
      stringToSign,
    ),
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": headers["content-type"],
      "x-amz-content-sha256": headers["x-amz-content-sha256"],
      "x-amz-date": headers["x-amz-date"],
      ...(config.sessionToken
        ? { "x-amz-security-token": config.sessionToken }
        : {}),
      authorization: [
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(", "),
    },
    body: payload,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new AppError("EMAIL_DELIVERY_FAILED", sesErrorMessage(body), 502, {
      provider: "ses",
      status: response.status,
    });
  }
}

export async function sendMagicLinkEmail(
  input: MagicLinkEmailInput,
): Promise<EmailDeliveryResult> {
  const bindings = await getRuntimeBindings();
  const provider = emailProvider(bindings);
  const from = sender(bindings);

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

  if (
    provider === "ses" ||
    provider === "aws_ses" ||
    provider === "amazon_ses"
  ) {
    await sendWithAwsSes(input, from, awsSesConfig(bindings));
    return { provider: "ses", sent: true };
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
