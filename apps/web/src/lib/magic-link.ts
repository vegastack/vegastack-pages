export function magicLinkHandoffUrl(origin: string, rawToken: string) {
  return `${origin}/auth/magic-link#token=${encodeURIComponent(rawToken)}`;
}
