import type { APIRoute } from "astro";
import { setup } from "@vegastack/pages-services";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../lib/service-context";

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request }) => {
  try {
    const { ctx } = await buildServiceContext({ cookies, request });
    const status = await setup.status(ctx);
    return Response.json({
      setup_required: !status.setupComplete,
      version: "0.1.0",
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Setup status check failed.");
  }
};
