import type { APIRoute } from "astro";

// Lightweight endpoint whose only job is to let the middleware mint a fresh
// vpg_csrf cookie when the client noticed it was missing. Browsers send the
// cookie back automatically on the retried mutating request.
export const prerender = false;
export const GET: APIRoute = () => new Response(null, { status: 204 });
