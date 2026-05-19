// RFC 8414 path-derived authorization-server metadata URLs can include the
// protected resource path. Some MCP clients probe
// `/.well-known/oauth-authorization-server/mcp` for an MCP endpoint at `/mcp`.
// Serve the same issuer metadata as the root well-known endpoint.
export const prerender = false;
export { OPTIONS, GET } from "../oauth-authorization-server.ts";
