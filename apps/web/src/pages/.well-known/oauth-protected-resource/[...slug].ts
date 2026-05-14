// RFC 9728 §3.1 derives the protected-resource metadata URL by inserting
// `/.well-known/oauth-protected-resource` between the host and the resource
// path component. For the MCP endpoint at `/mcp` that means
// `/.well-known/oauth-protected-resource/mcp` — which some clients (notably
// claude.ai's connector broker) probe first even when we advertise a
// different URL in the WWW-Authenticate `resource_metadata` parameter.
//
// We serve the same JSON the root-path variant returns so the broker can
// continue past PRM discovery without falling back.
export { OPTIONS, GET } from "../oauth-protected-resource.ts";
