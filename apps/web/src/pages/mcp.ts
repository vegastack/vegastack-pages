// Thin Astro APIRoute delegate. All MCP server logic lives in
// `apps/web/src/lib/mcp/server.ts` (and supporting tools/* modules).
export { GET, HEAD, OPTIONS, POST } from "../lib/mcp/server";

export const prerender = false;
