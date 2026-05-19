import { AppError } from "./errors";
import { createId, idPrefixes } from "./ids";

export type MagicLinkRecord = {
  id: string;
  email: string;
  tokenHash: string;
  redirectTo: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
};

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function safeMagicLinkRedirect(value?: string): string {
  if (!value) return "/";
  const redirect = value.trim();
  if (
    !redirect.startsWith("/") ||
    redirect.startsWith("//") ||
    redirect.includes("\\") ||
    /[\r\n]/.test(redirect)
  ) {
    return "/";
  }

  try {
    const base = "https://pages.local";
    const url = new URL(redirect, base);
    if (url.origin !== base) return "/";
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return "/";
  }
}

export class AuthService {
  private readonly magicLinks = new Map<string, MagicLinkRecord>();
  private readonly sessions = new Map<string, SessionRecord>();

  async createMagicLink(input: {
    email: string;
    redirectTo?: string;
    ttlMinutes?: number;
  }): Promise<{ link: MagicLinkRecord; rawToken: string }> {
    const rawToken = randomToken();
    const now = new Date();
    const link: MagicLinkRecord = {
      id: createId(idPrefixes.magicLink),
      email: input.email.trim().toLowerCase(),
      tokenHash: await sha256(rawToken),
      redirectTo: safeMagicLinkRedirect(input.redirectTo),
      expiresAt: new Date(
        now.getTime() + (input.ttlMinutes ?? 15) * 60_000,
      ).toISOString(),
      consumedAt: null,
      createdAt: now.toISOString(),
    };
    this.magicLinks.set(link.id, link);
    return { link, rawToken };
  }

  // Atomicity guarantees:
  //   - Within a single Worker isolate, the check-and-flip below is
  //     synchronous (no `await` between the `consumedAt` check and the
  //     assignment), so two concurrent `consumeMagicLink` calls cannot
  //     interleave between the check and the set. V8 single-threaded
  //     execution makes this safe without an explicit lock.
  //   - Across isolates, atomicity relies on the runtime mutation lock
  //     held by middleware on every mutating request. If a future
  //     refactor drops the global lock, this method MUST migrate to an
  //     atomic D1 `UPDATE magic_links SET consumed_at = ? WHERE
  //     token_hash = ? AND consumed_at IS NULL RETURNING …` so the
  //     database guarantees single-use.
  async consumeMagicLink(
    rawToken: string,
    userId: string,
  ): Promise<SessionRecord> {
    const link = await this.getMagicLink(rawToken);
    // Re-check consumedAt under the same synchronous slice as the flip.
    // assertUsableMagicLink already throws on consumed/expired; we just
    // want to make sure the check and the write live in one tick.
    this.assertUsableMagicLink(link);
    if (link.consumedAt) {
      // Belt-and-braces — if another caller flipped this between the
      // read inside getMagicLink and now, refuse.
      throw new AppError(
        "AUTH_REQUIRED",
        "Magic link token has already been used.",
        401,
      );
    }
    link.consumedAt = new Date().toISOString();
    this.magicLinks.set(link.id, link);
    return this.createSession(userId);
  }

  createSession(userId: string): SessionRecord {
    const now = new Date();
    const session: SessionRecord = {
      id: createId(idPrefixes.session),
      userId,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      createdAt: now.toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async verifyMagicLink(rawToken: string): Promise<MagicLinkRecord> {
    return this.assertUsableMagicLink(await this.getMagicLink(rawToken));
  }

  private async getMagicLink(rawToken: string): Promise<MagicLinkRecord> {
    const hash = await sha256(rawToken);
    const link = [...this.magicLinks.values()].find(
      (candidate) => candidate.tokenHash === hash,
    );
    if (!link)
      throw new AppError("AUTH_REQUIRED", "Magic link token is invalid.", 401);
    return link;
  }

  private assertUsableMagicLink(link: MagicLinkRecord): MagicLinkRecord {
    if (link.consumedAt)
      throw new AppError(
        "AUTH_REQUIRED",
        "Magic link token has already been used.",
        401,
      );
    if (Date.parse(link.expiresAt) <= Date.now())
      throw new AppError("AUTH_REQUIRED", "Magic link token has expired.", 401);
    const safeRedirectTo = safeMagicLinkRedirect(link.redirectTo);
    if (safeRedirectTo !== link.redirectTo) {
      link.redirectTo = safeRedirectTo;
      this.magicLinks.set(link.id, link);
    }
    return link;
  }

  getSession(sessionId: string): SessionRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    return session;
  }

  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
