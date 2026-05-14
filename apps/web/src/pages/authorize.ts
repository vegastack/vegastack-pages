// Root-level alias for the authorization endpoint. Spec-compliant clients
// use the `authorization_endpoint` value from the AS metadata, which points
// at `/oauth/authorize`. We mirror it at root so non-spec brokers that
// hardcode `${issuer}/authorize` continue to work.
export const prerender = false;
export { GET } from "./oauth/authorize";
