import type { APIRoute } from "astro";
import { setupService } from "../../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = () => {
  const status = setupService.status();
  return Response.json({
    setup_required: !status.setupComplete,
    version: "0.1.0",
  });
};
