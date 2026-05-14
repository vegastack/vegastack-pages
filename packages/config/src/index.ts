import { parse } from "yaml";
import { z } from "zod";

const runtimeTargetSchema = z.enum(["cloudflare", "node"]);
const deploymentModeSchema = z.enum(["self_hosted", "managed"]);

export const vegastackPagesConfigSchema = z.object({
  app: z.object({
    name: z.string().default("vegastack-pages"),
    base_url: z.string().url(),
    public_url_mode: z.enum(["clean"]).default("clean"),
    home_mode: z
      .enum(["landing", "redirect_to_app", "redirect_to_first_page"])
      .default("landing"),
    deployment_mode: deploymentModeSchema.default("self_hosted"),
  }),
  runtime: z.object({
    target: runtimeTargetSchema,
    environment: z
      .enum(["development", "test", "production"])
      .default("production"),
  }),
  cloudflare: z
    .object({
      account_id: z.string().optional(),
      worker_name: z.string().default("vegastack-pages"),
      compatibility_date: z.string().default("2026-05-10"),
      d1_database_name: z.string().default("vegastack_pages"),
      r2_bucket_name: z.string().default("vegastack-pages-content"),
      custom_domain: z.string().optional(),
      durable_object_namespace: z.string().default("VEGASTACK_PAGES_EVENTS"),
      github_sync_cron: z.string().default("17 2 * * *"),
    })
    .prefault({}),
  node: z
    .object({
      database_url: z.string().optional(),
      object_store: z
        .object({
          provider: z.enum(["s3", "filesystem"]).default("s3"),
          endpoint: z.string().optional(),
          bucket: z.string().optional(),
          region: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  security: z
    .object({
      setup_token_ttl_minutes: z.number().int().positive().default(30),
      version_retention_days: z.number().int().positive().default(30),
      session_ttl_days: z.number().int().positive().default(30),
      public_link_password_min_length: z.number().int().min(8).default(8),
    })
    .prefault({}),
  auth: z
    .object({
      magic_link: z.object({ enabled: z.boolean().default(true) }).prefault({}),
      google_oauth: z
        .object({ enabled: z.boolean().default(false) })
        .prefault({}),
      public_signup: z
        .object({
          enabled: z.boolean().default(false),
          create_workspace_on_signup: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  email: z
    .object({
      provider: z
        .enum(["none", "cloudflare_email_service", "ses"])
        .default("none"),
    })
    .prefault({}),
  limits: z
    .object({
      max_attachment_bytes: z.number().int().positive().default(10_485_760),
      max_page_source_bytes: z.number().int().positive().default(1_048_576),
      max_public_comment_body_bytes: z
        .number()
        .int()
        .positive()
        .default(10_000),
    })
    .prefault({}),
});

export type VegastackPagesConfig = z.infer<typeof vegastackPagesConfigSchema>;

export function resolveEnvPlaceholders(
  input: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return input.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_, name: string) => env[name] ?? "",
  );
}

export function parseVegastackPagesConfig(
  source: string,
  env?: Record<string, string | undefined>,
): VegastackPagesConfig {
  const resolved = resolveEnvPlaceholders(source, env);
  return vegastackPagesConfigSchema.parse(parse(resolved));
}

export function redactConfig(
  config: VegastackPagesConfig,
): VegastackPagesConfig {
  return structuredClone(config);
}
