// Root-level alias for RFC 7591 Dynamic Client Registration. The canonical
// endpoint is `/oauth/register` and is advertised that way in the
// authorization-server metadata, but some MCP clients (notably claude.ai's
// connector broker, observed via wrangler tail) ignore the
// `registration_endpoint` field and POST directly to `${issuer}/register`.
// Re-exporting the same handlers keeps both paths functional.
export const prerender = false;
export { OPTIONS, POST } from "./oauth/register";
