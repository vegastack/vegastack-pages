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
    // `adapter` is part of the local-setup script's safety contract
    // (see scripts/local-env.mjs#assertLocalNodeBackend) — it ensures
    // the script can't accidentally point at a production deployment.
    // Hardcoded to "node" here because this endpoint only exists in
    // dev (the `import.meta.env.DEV` guard above blocks production
    // bundles from registering it).
    adapter: "node",
    runtime: process.env.VPG_RUNTIME ?? "node",
    prod_data_dev: process.env.VPG_PROD_DATA_DEV === "true",
    sqlite_path: process.env.VPG_SQLITE_PATH ?? null,
    object_store_dir: process.env.VPG_OBJECT_STORE_DIR ?? null,
    base_url: process.env.VPG_BASE_URL ?? null,
    email_provider: process.env.VPG_EMAIL_PROVIDER ?? null,
    demo_seed: process.env.VPG_DEMO_SEED ?? null,
  });
};
