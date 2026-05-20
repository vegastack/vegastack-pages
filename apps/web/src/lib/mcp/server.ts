import {
  isMcpToolName,
  jsonRpcError,
  jsonRpcResult,
  mcpInstructions,
  mcpToolSpecs,
  type McpToolName,
} from "@vegastack/pages-mcp";
import { AppError, type UserRecord } from "@vegastack/pages-core";
import {
  audit,
  mcpSessions,
  users,
  type ServiceContext,
} from "@vegastack/pages-services";
import type { APIRoute } from "astro";
import { buildServiceContext } from "../service-context";
import { sha256Hex } from "../runtime";
import { devAutoLoginEnabled, devAutoLoginUser } from "../dev-auth";
import { validateHost } from "../oauth/issuer";
import { callTool } from "./dispatch";
import { listResources, readResource } from "./resources";
import { asRecord } from "./util";
import type { JsonRpcMessage, McpActor, McpToolContext } from "./types";

export const protocolVersion = "2025-11-25";
const defaultMaxBodyBytes = 2 * 1024 * 1024;

const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers":
    "mcp-protocol-version, mcp-session-id, www-authenticate",
  "Access-Control-Max-Age": "86400",
} as const;

const readOnlyToolNames = new Set<McpToolName>([
  "fetch",
  "search",
  "wait_for_review",
  "whoami",
  "validate_page_source",
  "render_template",
]);

const destructiveToolNames = new Set<McpToolName>([
  "delete_thread",
  "delete_publication",
]);

function titleFromToolName(name: McpToolName) {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Build once at module load — `tools/list` returns the same shape on every
// call.
const serializedTools = mcpToolSpecs.map((tool) => {
  const name = tool.name;
  const readOnly = readOnlyToolNames.has(name);
  const destructive = destructiveToolNames.has(name);
  return {
    ...tool,
    title: titleFromToolName(name),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: !readOnly,
    },
  };
});

export function withMcpCors(response: Response): Response {
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    if (!response.headers.has(key)) response.headers.set(key, value);
  }
  if (!response.headers.has("MCP-Protocol-Version")) {
    response.headers.set("MCP-Protocol-Version", protocolVersion);
  }
  return response;
}

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: MCP_CORS_HEADERS });

export const HEAD: APIRoute = () =>
  withMcpCors(
    new Response(null, {
      status: 200,
      headers: { Allow: "POST, GET, HEAD, OPTIONS" },
    }),
  );

export const GET: APIRoute = ({ request }) => {
  const encoder = new TextEncoder();
  const signal = request?.signal;
  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (timeout) clearTimeout(timeout);
  };
  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (value: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          cleanup();
        }
      };
      signal?.addEventListener("abort", cleanup, { once: true });
      enqueue(": VegaStack Pages MCP stream\n\n");
      interval = setInterval(() => {
        enqueue(": keepalive\n\n");
      }, 15_000);
      timeout = setTimeout(() => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Client may have disconnected — the stream is done.
        }
      }, 60_000);
    },
    cancel() {
      cleanup();
    },
  });

  return withMcpCors(
    new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }),
  );
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const hostError = validateHost(request);
    if (hostError) {
      return withMcpCors(
        Response.json(
          jsonRpcError(null, -32000, hostError, { code: "INVALID_HOST" }),
          { status: 403 },
        ),
      );
    }
    const parsed = parseJsonRpcBody(await readRequestBody(request));
    const needsRuntimeData = messagesNeedRuntimeData(parsed);
    const actor = await validateAuth(request, {
      fast: !needsRuntimeData,
    });
    if (needsRuntimeData) {
      await hydrateActorUser(actor, { reload: true });
    }

    // Build the service context once per request. The static-token audit
    // hook reuses the same ctx instead of rebuilding it.
    const context = await buildToolContext(request, actor);

    if (actor.authMode === "static_token") {
      await recordStaticTokenUse(parsed, request, actor, context.ctx);
    }

    return withMcpCors(await respondToMessages(parsed, context));
  } catch (error) {
    return withMcpCors(errorResponse(error, request));
  }
};

async function buildToolContext(
  request: Request,
  actor: McpActor,
  workspaceId?: string | null,
): Promise<McpToolContext> {
  // Auth was already resolved upstream by validateAuth. We must not thread
  // the request into buildServiceContext — getApiRequestActor only knows
  // browser-style bearer tokens.
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    workspaceId: workspaceId ?? actor.workspaceId ?? null,
  });
  ctx.actor = {
    userId: actor.user?.id ?? actor.userId ?? "",
    email: actor.user?.email ?? null,
    workspaceId: actor.workspaceId,
  };
  return { requestUrl: request.url, actor, ctx };
}

async function respondToMessages(
  parsed: JsonRpcMessage | JsonRpcMessage[],
  context: McpToolContext,
) {
  if (Array.isArray(parsed)) {
    // JSON-RPC 2.0: an empty batch is an Invalid Request — reply with a
    // single error envelope rather than 202. (Audit cycle 5 finding.)
    if (parsed.length === 0) {
      return Response.json(
        jsonRpcError(null, -32600, "Invalid Request: empty batch."),
      );
    }
    // Promise.allSettled — one failing message must not poison the batch.
    const settled = await Promise.allSettled(
      parsed.map((message) => handleMessage(message, context)),
    );
    const responses = settled.flatMap((entry, index) => {
      if (entry.status === "fulfilled") {
        return entry.value ? [entry.value] : [];
      }
      const id =
        parsed[index] &&
        typeof parsed[index] === "object" &&
        Object.hasOwn(parsed[index] as object, "id")
          ? (parsed[index] as JsonRpcMessage).id
          : null;
      if (entry.reason instanceof AppError) {
        return [
          jsonRpcError(id, -32000, entry.reason.message, entry.reason.toJSON()),
        ];
      }
      return [jsonRpcError(id, -32603, "MCP request failed.")];
    });
    return responses.length > 0
      ? Response.json(responses)
      : new Response(null, { status: 202 });
  }
  const response = await handleMessage(parsed, context);
  return response
    ? Response.json(response)
    : new Response(null, { status: 202 });
}

async function recordStaticTokenUse(
  parsed: JsonRpcMessage | JsonRpcMessage[],
  request: Request,
  actor: McpActor,
  ctx: ServiceContext,
) {
  const methods = (Array.isArray(parsed) ? parsed : [parsed])
    .map((message) => message.method)
    .filter((method): method is string => typeof method === "string");
  await audit.record(ctx, {
    workspaceId: actor.workspaceId,
    actorUserId: actor.user?.id ?? null,
    action: "mcp.static_token_used",
    targetType: "mcp",
    targetId: actor.user?.id ?? "static_token",
    metadata: {
      methods,
      cf_connecting_ip: request.headers.get("cf-connecting-ip"),
      origin: request.headers.get("origin"),
    },
  });
}

function messagesNeedRuntimeData(body: JsonRpcMessage | JsonRpcMessage[]) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    const method = String(message?.method ?? "");
    return ![
      "initialize",
      "ping",
      "notifications/initialized",
      "tools/list",
      "prompts/list",
      "prompts/get",
    ].includes(method);
  });
}

async function handleMessage(body: JsonRpcMessage, context: McpToolContext) {
  const hasId = Boolean(
    body && typeof body === "object" && Object.hasOwn(body, "id"),
  );
  const id = hasId ? body.id : null;
  const method =
    body && typeof body === "object" ? String(body.method ?? "") : "";

  try {
    if (
      !body ||
      typeof body !== "object" ||
      body.jsonrpc !== "2.0" ||
      !method
    ) {
      return jsonRpcError(id, -32600, "Invalid JSON-RPC request.");
    }

    if (!hasId && method.startsWith("notifications/")) {
      return null;
    }

    if (method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion,
        serverInfo: { name: "VegaStack Pages", version: "0.1.0" },
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions: mcpInstructions,
      });
    }
    if (method === "ping") {
      return jsonRpcResult(id, {});
    }
    if (method === "tools/list") {
      return jsonRpcResult(id, { tools: serializedTools });
    }
    if (method === "resources/list") {
      return jsonRpcResult(id, { resources: await listResources(context) });
    }
    if (method === "resources/read") {
      return jsonRpcResult(
        id,
        await readResource(String(body.params?.uri ?? ""), context),
      );
    }
    if (method === "prompts/list") {
      return jsonRpcResult(id, { prompts: listPrompts() });
    }
    if (method === "prompts/get") {
      return jsonRpcResult(
        id,
        getPrompt(
          String(body.params?.name ?? ""),
          asRecord(body.params?.arguments),
        ),
      );
    }
    if (method === "tools/call") {
      const name = String(body.params?.name ?? "");
      if (!isMcpToolName(name))
        return jsonRpcError(id, -32602, "Unknown tool.");
      const result = await callTool(
        name,
        asRecord(body.params?.arguments),
        context,
      );
      // Per MCP spec (2025-11-25): tools that return structuredContent
      // SHOULD also serialize the JSON into a TextContent block for
      // backwards compatibility. Most clients (Claude.ai, Cursor) read
      // from `content[0].text` and ignore `structuredContent` unless the
      // tool declares an outputSchema. Earlier this collapsed to a
      // one-line summary like "<tool>: ok", which left clients with no
      // payload to parse.
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }

    return jsonRpcError(id, -32601, "Method not found.");
  } catch (error) {
    if (error instanceof AppError) {
      return jsonRpcError(id, -32000, error.message, error.toJSON());
    }
    return jsonRpcError(id, -32603, "MCP request failed.");
  }
}

function listPrompts() {
  return [
    {
      name: "vegastack_review_page",
      description:
        "Review a page, wait for comments, and resolve feedback safely.",
      arguments: [
        { name: "page_id", description: "Page id to review", required: true },
      ],
    },
    {
      name: "vegastack_edit_page_safely",
      description: "Fetch source, validate, patch, and handle conflicts.",
      arguments: [
        { name: "page_id", description: "Page id to edit", required: true },
        {
          name: "change",
          description: "Requested source change",
          required: true,
        },
      ],
    },
    {
      name: "vegastack_create_or_update_template",
      description: "Create or update a structured VegaStack Pages template.",
      arguments: [
        {
          name: "workspace_id",
          description:
            "Workspace id. Required for every workspace-scoped MCP tool call.",
          required: true,
        },
      ],
    },
  ];
}

function getPrompt(name: string, args: Record<string, unknown>) {
  const pageId = args.page_id ? String(args.page_id) : "<page_id>";
  const change = args.change ? String(args.change) : "<describe the change>";
  const workspaceId = args.workspace_id
    ? String(args.workspace_id)
    : "<workspace_id>";
  const prompts: Record<string, string> = {
    vegastack_review_page: [
      `Review VegaStack Pages page ${pageId}.`,
      "Use fetch with include=['comments','review_events'] first.",
      "If you created the page, publish it with comment access, tell the user the URL, then wait up to 10 minutes with wait_for_review timeout_ms=600000.",
      "When comments arrive, act on them immediately instead of asking the user to paste them back into chat.",
      "When changing source, call fetch with include=['source','edit_tokens'] before update_page.",
      "Use update_thread with agent metadata for each resolved thread.",
    ].join("\n"),
    vegastack_edit_page_safely: [
      `Edit VegaStack Pages page ${pageId}: ${change}`,
      "Call fetch with include=['source','edit_tokens'], validate the intended source, then prefer update_page with find/replace and expected_replacements.",
      "If the base version or content hash is stale, refetch and reapply the change. (Replaces the old prepare_page_edit + patch_page workflow.)",
    ].join("\n"),
    vegastack_create_or_update_template: [
      `Create or update a VegaStack Pages template in workspace ${workspaceId}.`,
      "Use create_template or update_template with builder.sections levels 2, 3, or 4.",
      "Include every frontmatter field in properties with type, label, defaults, options, and required state.",
    ].join("\n"),
  };
  const text = prompts[name];
  if (!text) {
    throw new AppError("PAGE_NOT_FOUND", "MCP prompt was not found.", 404);
  }
  return {
    description: name,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

async function readRequestBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  const maxBodyBytes = Number(
    process.env.VPG_MCP_MAX_BODY_BYTES ?? defaultMaxBodyBytes,
  );
  if (contentLength && Number(contentLength) > maxBodyBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      "MCP request body is too large.",
      413,
      {
        max_body_bytes: maxBodyBytes,
      },
    );
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      "MCP request body is too large.",
      413,
      {
        max_body_bytes: maxBodyBytes,
      },
    );
  }
  return text;
}

function parseJsonRpcBody(text: string): JsonRpcMessage | JsonRpcMessage[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as JsonRpcMessage[];
    return parsed as JsonRpcMessage;
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "MCP request body must be valid JSON.",
      400,
    );
  }
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function adoptUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  role: "user" | "instance_admin";
  createdAt: string;
  updatedAt: string;
}): UserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function validateAuth(
  request: Request,
  options: { fast?: boolean } = {},
): Promise<McpActor> {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const token = process.env.VPG_MCP_TOKEN;
  const authRequired =
    process.env.VPG_MCP_AUTH_REQUIRED === "true" ||
    Boolean(token) ||
    !devAutoLoginEnabled();

  if (bearer && token && constantTimeEqual(bearer, token)) {
    if (
      !import.meta.env.DEV &&
      process.env.VPG_ALLOW_STATIC_MCP_TOKEN !== "true"
    ) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Static MCP bearer tokens are disabled in production. Create a workspace-scoped MCP session from the web app.",
        401,
      );
    }
    const configuredEmail = process.env.VPG_MCP_STATIC_USER_EMAIL;
    const user = configuredEmail
      ? await users.getByEmail(ctx, configuredEmail)
      : await devAutoLoginUser();
    if (!user) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Static MCP token must map to an existing user.",
        401,
      );
    }
    const staticWorkspaceId = process.env.VPG_MCP_WORKSPACE_ID ?? null;
    if (
      process.env.VPG_ALLOW_STATIC_MCP_TOKEN === "true" &&
      !staticWorkspaceId
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "VPG_MCP_WORKSPACE_ID is required when static MCP tokens are enabled.",
        400,
      );
    }
    return {
      user: adoptUser(user),
      authMode: "static_token",
      workspaceId: staticWorkspaceId,
    };
  }

  if (bearer) {
    let mcpSession = await mcpSessions.findByBearerToken(ctx, bearer);
    if (!mcpSession) {
      const hashedSessionId = `mcp_${await sha256Hex(bearer)}`;
      mcpSession = await mcpSessions.findByBearerToken(ctx, hashedSessionId);
    }
    const mcpUser =
      mcpSession && mcpSession.userId
        ? await users.getById(ctx, mcpSession.userId)
        : null;
    if (mcpSession && (mcpUser || options.fast)) {
      return {
        user: mcpUser ? adoptUser(mcpUser) : null,
        userId: mcpSession.userId,
        authMode: "session",
        workspaceId: mcpSession.workspaceId,
      };
    }
  }

  if (!authRequired) {
    const devUser = await devAutoLoginUser();
    return {
      user: devUser,
      userId: devUser?.id ?? null,
      authMode: devUser ? "session" : "anonymous",
      workspaceId: null,
    };
  }

  throw new AppError("AUTH_REQUIRED", "MCP bearer token is required.", 401);
}

async function hydrateActorUser(
  actor: McpActor,
  options: { reload?: boolean } = {},
) {
  if (actor.user && !options.reload) return;
  if (!actor.userId) return;
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
    request: new Request("http://localhost/"),
  });
  const user = await users.getById(ctx, actor.userId);
  if (!user) {
    throw new AppError("AUTH_REQUIRED", "MCP session user was not found.", 401);
  }
  actor.user = adoptUser(user);
}

function errorResponse(error: unknown, request?: Request) {
  const id = null;
  if (error instanceof AppError) {
    const headers: Record<string, string> = {};
    if (error.status === 401) {
      const origin = request ? deriveIssuerOrigin(request) : "";
      const resourceMetadata = origin
        ? `${origin}/.well-known/oauth-protected-resource/mcp`
        : "/.well-known/oauth-protected-resource/mcp";
      headers["WWW-Authenticate"] =
        `Bearer realm="VegaStack Pages MCP", ` +
        `resource_metadata="${resourceMetadata}", ` +
        `error="invalid_token", ` +
        `error_description="Bearer token required"`;
    }
    return Response.json(
      jsonRpcError(id, -32000, error.message, error.toJSON()),
      { status: error.status, headers },
    );
  }
  return Response.json(jsonRpcError(id, -32603, "MCP request failed."), {
    status: 500,
  });
}

function deriveIssuerOrigin(request: Request): string {
  const headers = request.headers;
  const forwardedProto = headers.get("x-forwarded-proto");
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost) {
    const proto = (forwardedProto ?? "https").split(",")[0]!.trim();
    const host = forwardedHost.split(",")[0]!.trim();
    return `${proto}://${host}`;
  }
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}
