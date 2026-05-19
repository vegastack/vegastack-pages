import { AppError } from "@vegastack/pages-core";
import type { McpToolContext } from "./types";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

export function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function requiredWorkspaceId(value: unknown) {
  const workspaceId = asString(value).trim();
  if (!workspaceId) {
    throw new AppError("WORKSPACE_REQUIRED", "workspace_id is required.", 400, {
      parameter: "workspace_id",
      hint: "Pass the explicit workspace_id with every MCP tool call.",
    });
  }
  return workspaceId;
}

export function assertMcpWorkspaceMatches(
  value: unknown,
  actualWorkspaceId: string,
  resource: string,
) {
  const workspaceId = requiredWorkspaceId(value);
  if (workspaceId !== actualWorkspaceId) {
    throw new AppError(
      "PERMISSION_DENIED",
      `workspace_id does not match this ${resource}.`,
      403,
      {
        parameter: "workspace_id",
        received_workspace_id: workspaceId,
      },
    );
  }
}

export function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function absoluteUrl(context: McpToolContext, path: string) {
  return new URL(path, context.requestUrl).toString();
}

export function pageMutationResult(
  page: { id: string; slugId: string; versionId: string; contentHash: string },
  context: McpToolContext,
) {
  return {
    page_id: page.id,
    slug_id: page.slugId,
    url: absoluteUrl(context, `/p/${page.slugId}`),
    version_id: page.versionId,
    content_hash: page.contentHash,
  };
}
