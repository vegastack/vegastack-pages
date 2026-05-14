const runtimeBypassPrefixes = ["/docs"];

export function bypassesRuntimePersistence(input: {
  method: string;
  pathname: string;
}) {
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return false;
  }
  return runtimeBypassPrefixes.some(
    (prefix) =>
      input.pathname === prefix || input.pathname.startsWith(`${prefix}/`),
  );
}
