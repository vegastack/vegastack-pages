import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = () => {
  if (!import.meta.env.DEV) {
    return Response.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Local development status is not available.",
        },
      },
      { status: 404 },
    );
  }

  return Response.json({
    ok: true,
    runtime: process.env.VPG_RUNTIME ?? null,
    prod_data_dev: process.env.VPG_PROD_DATA_DEV === "true",
    sqlite_path: process.env.VPG_SQLITE_PATH ?? null,
    object_store_dir: process.env.VPG_OBJECT_STORE_DIR ?? null,
    base_url: process.env.VPG_BASE_URL ?? null,
    email_provider: process.env.VPG_EMAIL_PROVIDER ?? null,
    demo_seed: process.env.VPG_DEMO_SEED ?? null,
  });
};
