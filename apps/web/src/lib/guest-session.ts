import { AppError, type PublicationRecord } from "@vegastack/pages-core";
import type { AstroCookies } from "astro";

export type GuestSession = {
  id: string;
  publicationId: string;
  guestName: string;
};

type GuestSessionCookie = GuestSession & {
  v: 1;
  sig: string;
};

function randomGuestSessionId() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `gst_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sanitizeCookieName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function guestSessionCookieName(publicationId: string) {
  return `vpg_guest_${sanitizeCookieName(publicationId)}`;
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signature(
  session: GuestSession,
  publication: PublicationRecord,
) {
  return sha256(
    `v1:${session.id}:${session.publicationId}:${session.guestName}:${publication.passwordHash ?? ""}:${publication.updatedAt}`,
  );
}

async function encodeGuestSession(
  session: GuestSession,
  publication: PublicationRecord,
) {
  const value: GuestSessionCookie = {
    v: 1,
    ...session,
    sig: await signature(session, publication),
  };
  return encodeURIComponent(JSON.stringify(value));
}

async function decodeGuestSession(
  value: string,
  publication: PublicationRecord,
): Promise<GuestSession | null> {
  try {
    const parsed = JSON.parse(
      decodeURIComponent(value),
    ) as Partial<GuestSessionCookie>;
    if (
      parsed.v !== 1 ||
      parsed.publicationId !== publication.id ||
      !parsed.id ||
      !parsed.guestName ||
      !parsed.sig
    ) {
      return null;
    }
    const session: GuestSession = {
      id: String(parsed.id),
      publicationId: publication.id,
      guestName: String(parsed.guestName),
    };
    return (await signature(session, publication)) === parsed.sig
      ? session
      : null;
  } catch {
    return null;
  }
}

export async function guestSessionForPublication(input: {
  cookies: AstroCookies;
  url: URL;
  publication: PublicationRecord;
  requestedName: string | null;
}) {
  const cookieName = guestSessionCookieName(input.publication.id);
  const existing = input.cookies.get(cookieName)?.value;
  if (existing) {
    const session = await decodeGuestSession(existing, input.publication);
    if (session) return session;
  }

  const guestName = input.requestedName?.trim();
  if (!guestName) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Guest name is required for public comments.",
      400,
    );
  }
  const session: GuestSession = {
    id: randomGuestSessionId(),
    publicationId: input.publication.id,
    guestName,
  };
  input.cookies.set(
    cookieName,
    await encodeGuestSession(session, input.publication),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: input.url.protocol === "https:",
      path: "/",
      expires: input.publication.expiresAt
        ? new Date(input.publication.expiresAt)
        : new Date(Date.now() + 30 * 24 * 60 * 60_000),
    },
  );
  return session;
}
