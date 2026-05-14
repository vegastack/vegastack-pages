// Root-level alias for the OAuth token endpoint. See ./register.ts for the
// rationale — some MCP clients ignore advertised endpoint URLs and probe
// root-level conventional paths.
export const prerender = false;
export { OPTIONS, POST } from "./oauth/token";
