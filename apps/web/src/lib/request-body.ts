import { AppError } from "@vegastack/pages-core";

export function numericEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function assertUtf8ByteLimit(input: {
  value: string;
  maxBytes: number;
  label: string;
  detailKey: string;
}) {
  const byteLength = utf8ByteLength(input.value);
  if (byteLength <= input.maxBytes) return;
  throw new AppError(
    "PAYLOAD_TOO_LARGE",
    `${input.label} exceeds the configured size limit.`,
    413,
    {
      [input.detailKey]: input.maxBytes,
      actual_bytes: byteLength,
    },
  );
}

async function readTextBody(request: Request, maxBytes: number, label: string) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `${label} request body is too large.`,
      413,
      { max_body_bytes: maxBytes },
    );
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        `${label} request body is too large.`,
        413,
        { max_body_bytes: maxBytes },
      );
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readJsonBody<T = Record<string, unknown>>(
  request: Request,
  input: { maxBytes: number; label: string },
): Promise<T> {
  const text = await readTextBody(request, input.maxBytes, input.label);
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body must be valid JSON.",
      400,
    );
  }
}
