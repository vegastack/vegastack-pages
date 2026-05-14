export function clientRateLimitKey(request: Request, namespace: string) {
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return `${namespace}:ip:${cfConnectingIp}`;
  return `${namespace}:ip:unknown`;
}
