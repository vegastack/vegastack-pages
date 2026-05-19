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

  // Retry transient 5xx responses with jittered backoff. SES has
  // documented 95th-percentile latency for SendRawEmail under 500ms;
  // two retries with ~250ms jitter add at most ~1s total before
  // surfacing the failure. 4xx responses (auth errors, validation
  // failures, throttling-by-suppression-list) are NOT retryable —
  // they fail fast and let the caller fall back to the Cloudflare
  // binding if available.
  const requestInit: RequestInit = {
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
  };

  const maxAttempts = 3;
  let lastError: { status: number; body: string } | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, requestInit);
    } catch (networkError) {
      // fetch threw (DNS, TLS, abort, etc). Treat as retryable.
      lastError = {
        status: 0,
        body:
          networkError instanceof Error
            ? networkError.message
            : String(networkError),
      };
      if (attempt < maxAttempts) {
        await sleep(250 + Math.floor(Math.random() * 250));
        continue;
      }
      break;
    }
    if (response.ok) return;
    const body = await response.text();
    lastError = { status: response.status, body };
    // 5xx + 429 retry; 4xx other than 429 fails fast.
    const retryable = response.status >= 500 || response.status === 429;
    if (!retryable || attempt === maxAttempts) break;
    await sleep(250 + Math.floor(Math.random() * 250));
  }
  throw new AppError(
    "EMAIL_DELIVERY_FAILED",
    sesErrorMessage(lastError?.body ?? ""),
    502,
    {
      provider: "ses",
      status: lastError?.status ?? 0,
      attempts: maxAttempts,
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Canonical outbound mail path for VegaStack Pages.
//
// Provider model (per plan 010 §1.12):
//
//   • `aws_ses`   — AWS SES via signed HTTPS (SendRawEmail). Primary
//                   production path: best-in-class transactional
//                   deliverability, dedicated-IP-eligible, works
//                   identically on Cloudflare Workers and self-host Node.
//
//   • `cloudflare`— Cloudflare Email Sending via the `send_email`
//                   binding (`env.EMAIL.send`). Useful as a secondary
//                   path inside Email Routing's `email()` inbound
//                   handler (sending a reply from the same Worker that
//                   received the message) and as a no-AWS fallback for
//                   small self-hosters who haven't provisioned SES.
//
//   • `console`   — Dev/log-only. Magic link is printed (with the token
//                   redacted) to stdout. Useful for local development.
//
//   • `auto`      — Pick SES if AWS_* secrets are present; else the
//                   Cloudflare binding if EMAIL is bound; else
//                   `console` in dev, error otherwise. This is the
//                   recommended VPG_EMAIL_PROVIDER value in production.
//
// Cloudflare Email Routing (inbound) is configured at the zone level
// in the Cloudflare dashboard; the optional `email()` handler in
// `apps/web/src/worker.ts` can intercept and reply via `env.EMAIL.send`.
// See https://developers.cloudflare.com/email-routing/ and
// https://developers.cloudflare.com/email-service/.
export async function sendMagicLinkEmail(
  input: MagicLinkEmailInput,
): Promise<EmailDeliveryResult> {
  const bindings = await getRuntimeBindings();
  const provider = emailProvider(bindings);
  const from = sender(bindings);

  const sesConfig = awsSesConfig(bindings);
  const sesConfigured = Boolean(
    sesConfig.region && sesConfig.accessKeyId && sesConfig.secretAccessKey,
  );
  const cloudflareConfigured = Boolean(bindings?.EMAIL);

  // SES path (explicit or auto-selected when AWS credentials are set).
  if (
    provider === "ses" ||
    provider === "aws_ses" ||
    provider === "amazon_ses" ||
    (provider === "auto" && sesConfigured)
  ) {
    try {
      await sendWithAwsSes(input, from, sesConfig);
      return { provider: "ses", sent: true };
    } catch (sesError) {
      // When SES fails AND a Cloudflare binding is configured, fall
      // back to the Cloudflare path so a degraded SES (sandbox cap,
      // throttling, 5xx) doesn't take the login flow down. The
      // failure is logged for ops visibility. Strictly SES-only
      // deployments (provider === "ses") still bubble the error.
      const sesOnly =
        provider === "ses" ||
        provider === "aws_ses" ||
        provider === "amazon_ses";
      if (sesOnly || !cloudflareConfigured || !bindings?.EMAIL || !from.email) {
        throw sesError;
      }
      console.log(
        JSON.stringify({
          event: "vpg.email.ses.failed_falling_back",
          level: "warn",
          to: input.to,
          error:
            sesError instanceof Error ? sesError.message : String(sesError),
        }),
      );
      await sendWithCloudflareBinding(input, from);
      return { provider: "cloudflare", sent: true };
    }
  }

  // Cloudflare send_email binding (explicit or auto-fallback).
  if (
    provider === "cloudflare" ||
    provider === "cloudflare_email_service" ||
    (provider === "auto" && cloudflareConfigured)
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

  // Dev / log-only fallback. Production should never reach this branch.
  if (import.meta.env.DEV || provider === "console") {
    console.info(
      `[VegaStack Pages] Magic link for ${input.to}: ${redactMagicLinkUrl(input.verifyUrl)}`,
    );
    return { provider: "console", sent: false };
  }

  throw new AppError(
    "EMAIL_NOT_CONFIGURED",
    "Email delivery is not configured for this instance. Set VPG_EMAIL_PROVIDER plus the corresponding credentials (AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY for SES, or the EMAIL binding for Cloudflare).",
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
