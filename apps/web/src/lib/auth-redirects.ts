export function safeLocalRedirectPath(
  value: string | null | undefined,
  fallback = "/app",
) {
  const path = value?.trim();
  if (
    !path ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.startsWith("/\\")
  ) {
    return fallback;
  }
  return path;
}

export function loginRedirectTarget(value: string | null | undefined) {
  const target = safeLocalRedirectPath(value, "/app");
  return target === "/login" || target === "/app/login" ? "/app" : target;
}
