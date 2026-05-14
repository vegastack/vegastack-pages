import type { APIRoute } from "astro";
import {
  auditService,
  d1Run,
  findMcpSessionByRefreshToken,
  getMcpSession,
  revokeMcpSession,
  sha256Hex,
} from "../../lib/runtime";

export const prerender = false;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
} as const;

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders });

async function parseFormOrJson(
  request: Request,
): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  const result: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = String(value ?? "");
      }
    } catch {
      // ignore
    }
    return result;
  }
  const form = await request.formData();
  for (const [key, value] of form.entries()) {
    result[key] = String(value);
  }
  return result;
}

export const POST: APIRoute = async ({ request }) => {
  const body = await parseFormOrJson(request);
  const token = body.token ?? "";
  const hint = body.token_type_hint ?? "";
  if (!token) {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  let sessionId: string | null = null;
  let userId: string | null = null;
  let workspaceId: string | null = null;
  if (hint === "refresh_token" || !hint) {
    const refreshSession = await findMcpSessionByRefreshToken(token);
    if (refreshSession) {
      sessionId = refreshSession.id;
      userId = refreshSession.userId;
      workspaceId = refreshSession.workspaceId;
    }
  }
  if (!sessionId && (hint === "access_token" || !hint)) {
    const accessSession = await getMcpSession(token);
    if (accessSession) {
      sessionId = accessSession.id;
      userId = accessSession.userId;
      workspaceId = accessSession.workspaceId;
    }
  }
  if (sessionId && workspaceId) {
    await revokeMcpSession({ workspaceId, sessionId });
    await d1Run("DELETE FROM agent_sessions WHERE id = ?", sessionId);
    auditService.record({
      workspaceId,
      actorUserId: userId,
      action: "oauth.session_revoked",
      targetType: "mcp_session",
      targetId: sessionId,
      metadata: { reason: "user" },
    });
  } else if (sessionId) {
    const fallbackHash = await sha256Hex(token);
    await d1Run("DELETE FROM mcp_sessions WHERE id = ?", sessionId);
    await d1Run(
      "DELETE FROM mcp_sessions WHERE refresh_token_hash = ?",
      `mcp_${fallbackHash}`,
    );
    await d1Run("DELETE FROM agent_sessions WHERE id = ?", sessionId);
    auditService.record({
      workspaceId: null,
      actorUserId: userId,
      action: "oauth.session_revoked",
      targetType: "mcp_session",
      targetId: sessionId,
      metadata: { reason: "user" },
    });
  }
  return new Response(null, { status: 200, headers: corsHeaders });
};
