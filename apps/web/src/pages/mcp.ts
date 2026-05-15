import {
  isMcpToolName,
  jsonRpcError,
  jsonRpcResult,
  mcpInstructions,
  mcpToolSpecs,
  type McpToolName,
} from "@vegastack/pages-mcp";
import {
  AppError,
  hasPermission,
  templateBuilderFromMarkdown,
  templateBuilderToMarkdown,
  type PermissionLevel,
  type SearchResourceType,
  type TemplateBuilderDocument,
  type TemplateBuilderHeadingLevel,
  type TemplateProperty,
  type TemplateRecord,
  type UserRecord,
} from "@vegastack/pages-core";
import { flattenFrontmatter } from "@vegastack/pages-renderer";
import type { APIRoute } from "astro";
import {
  attachmentService,
  auditService,
  authService,
  commentService,
  ensureSeedData,
  acquireRuntimeMutationLock,
  getMcpSession,
  getMcpSessionFast,
  getUserFast,
  scheduleIndexCommentThread,
  scheduleIndexPage,
  pageService,
  permissionService,
  persistRuntimeState,
  pruneExpiredVersions,
  publicationService,
  refreshRuntimeState,
  reviewEventService,
  removeSearchResource,
  searchIndexedResources,
  templateService,
  workspaceService,
} from "../lib/runtime";
import { sendMagicLinkEmail } from "../lib/email";
import { devAutoLoginEnabled, devAutoLoginUser } from "../lib/dev-auth";
import { coerceCommentAnchor } from "../lib/comment-anchor-api";
import { assertPublicationPasswordPolicy } from "../lib/share-password-policy";
import { serializePublication } from "../lib/publication-api";
import { renderCachedMarkdown } from "../lib/render-cache";
import {
  buildWorkspaceNavigation,
  filterWorkspaceNavigation,
} from "../lib/workspace-navigation";
import { validateEditableSource } from "../lib/source-validation";
import { validateHost } from "../lib/oauth/issuer";
import skillCli from "../../../../skills/vegastack-pages/references/cli.md?raw";
import skillComments from "../../../../skills/vegastack-pages/references/comments.md?raw";
import skillMcp from "../../../../skills/vegastack-pages/references/mcp.md?raw";
import skillSecurity from "../../../../skills/vegastack-pages/references/security.md?raw";
import skillTemplates from "../../../../skills/vegastack-pages/references/templates.md?raw";
import skillWorkflows from "../../../../skills/vegastack-pages/references/workflows.md?raw";
import skillReadme from "../../../../skills/vegastack-pages/SKILL.md?raw";

export const prerender = false;

const protocolVersion = "2025-11-25";
const defaultMaxBodyBytes = 2 * 1024 * 1024;
const activeWaitForReviewCalls = new Set<string>();
const skillResources = [
  [
    "vpg://skills/vegastack-pages/SKILL.md",
    "VegaStack Pages skill",
    skillReadme,
  ],
  [
    "vpg://skills/vegastack-pages/references/mcp.md",
    "VegaStack Pages MCP reference",
    skillMcp,
  ],
  [
    "vpg://skills/vegastack-pages/references/cli.md",
    "VegaStack Pages CLI reference",
    skillCli,
  ],
  [
    "vpg://skills/vegastack-pages/references/comments.md",
    "VegaStack Pages comments and anchors reference",
    skillComments,
  ],
  [
    "vpg://skills/vegastack-pages/references/workflows.md",
    "VegaStack Pages workflow reference",
    skillWorkflows,
  ],
  [
    "vpg://skills/vegastack-pages/references/templates.md",
    "VegaStack Pages template reference",
    skillTemplates,
  ],
  [
    "vpg://skills/vegastack-pages/references/security.md",
    "VegaStack Pages security reference",
    skillSecurity,
  ],
] as const;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

type McpToolContext = {
  requestUrl: string;
  actor: McpActor;
};

type McpActor = {
  user: UserRecord | null;
  userId?: string | null;
  authMode: "session" | "static_token" | "anonymous";
  workspaceId: string | null;
};

const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers":
    "mcp-protocol-version, mcp-session-id, www-authenticate",
  "Access-Control-Max-Age": "86400",
} as const;

function withMcpCors(response: Response): Response {
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
          // The client may have already disconnected; the stream is done.
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
    if (process.env.VPG_MCP_TOKEN) {
      await ensureSeedData();
    }
    const parsed = parseJsonRpcBody(await readRequestBody(request));
    const needsRuntimeData = messagesNeedRuntimeData(parsed);
    const actor = await validateAuth(request, {
      fast: !needsRuntimeData,
    });
    if (needsRuntimeData) {
      return withMcpCors(
        await handleRuntimeDataRequest(parsed, request, actor),
      );
    }
    if (actor.authMode === "static_token") {
      recordStaticTokenUse(parsed, request, actor);
    }

    return withMcpCors(await respondToMessages(parsed, request, actor));
  } catch (error) {
    return withMcpCors(errorResponse(error, request));
  }
};

async function handleRuntimeDataRequest(
  parsed: JsonRpcMessage | JsonRpcMessage[],
  request: Request,
  actor: McpActor,
) {
  const lock = await acquireRuntimeMutationLock();
  try {
    await refreshRuntimeState();
    await ensureSeedData();
    hydrateActorUser(actor, { reload: true });
    if (actor.authMode === "static_token") {
      recordStaticTokenUse(parsed, request, actor);
    }
    const response = await respondToMessages(parsed, request, actor);
    if (response.status < 400) {
      await pruneExpiredVersions();
      await persistRuntimeState();
    }
    return response;
  } finally {
    await lock.release();
  }
}

async function respondToMessages(
  parsed: JsonRpcMessage | JsonRpcMessage[],
  request: Request,
  actor: McpActor,
) {
  if (Array.isArray(parsed)) {
    const responses = (
      await Promise.all(
        parsed.map((message) =>
          handleMessage(message, { requestUrl: request.url, actor }),
        ),
      )
    ).filter(Boolean);
    return responses.length > 0
      ? Response.json(responses)
      : new Response(null, { status: 202 });
  }

  const response = await handleMessage(parsed, {
    requestUrl: request.url,
    actor,
  });
  return response
    ? Response.json(response)
    : new Response(null, { status: 202 });
}

function recordStaticTokenUse(
  parsed: JsonRpcMessage | JsonRpcMessage[],
  request: Request,
  actor: McpActor,
) {
  const methods = (Array.isArray(parsed) ? parsed : [parsed])
    .map((message) => message.method)
    .filter((method): method is string => typeof method === "string");
  auditService.record({
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

const readOnlyToolNames = new Set<McpToolName>([
  "prepare_page_edit",
  "get_page",
  "list_page_versions",
  "validate_page_source",
  "wait_for_review",
  "list_comments",
  "list_review_events",
  "search_workspace",
  "list_workspace",
  "list_templates",
  "get_template",
  "render_template",
  "list_workspaces",
  "whoami",
]);

const destructiveToolNames = new Set<McpToolName>([
  "delete_thread",
  "publication_delete",
]);

function titleFromToolName(name: McpToolName) {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function serializeToolsForClient() {
  return mcpToolSpecs.map((tool) => {
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
      return jsonRpcResult(id, { tools: serializeToolsForClient() });
    }
    if (method === "resources/list") {
      return jsonRpcResult(id, { resources: listResources(context) });
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
      return jsonRpcResult(id, {
        content: [{ type: "text", text: compactToolText(name, result) }],
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

function compactToolText(name: string, result: unknown) {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as Record<string, unknown>;
  if (typeof record.status === "string") return `${name}: ${record.status}`;
  if (record.page_id) return `${name}: ${String(record.page_id)}`;
  if (record.publication_id) return `${name}: ${String(record.publication_id)}`;
  if (Array.isArray(record.results))
    return `${name}: ${record.results.length} results`;
  if (Array.isArray(record.threads))
    return `${name}: ${record.threads.length} threads`;
  if (Array.isArray(record.events))
    return `${name}: ${record.events.length} events`;
  return `${name}: ok`;
}

async function callTool(
  name: McpToolName,
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  switch (name) {
    case "create_page": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "write");
      const created = await pageService.createPage({
        workspaceId,
        folderPath: args.folder_path ? String(args.folder_path) : "",
        title: asString(args.title, "Untitled"),
        sourceType:
          args.source_type === "mdx" || args.source_type === "html"
            ? args.source_type
            : "markdown",
        source: asString(args.source, ""),
      });
      scheduleIndexPage(created.page.id);
      reviewEventService.emit({
        workspaceId: created.page.workspaceId,
        pageId: created.page.id,
        type: "page.created",
        actorUserId: null,
        payload: {
          page_id: created.page.id,
          version_id: created.page.versionId,
          source: "mcp",
        },
      });
      return pageMutationResult(created.page, context);
    }
    case "prepare_page_edit": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      return {
        page: page.page,
        source: page.source,
        base_version_id: page.page.versionId,
        base_content_hash: page.page.contentHash,
        update_page_arguments: {
          workspace_id: page.page.workspaceId,
          page_id: page.page.id,
          base_version_id: page.page.versionId,
          base_content_hash: page.page.contentHash,
          source: page.source,
        },
      };
    }
    case "patch_page": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      assertEditBase(page.page, args);
      const patched = patchSource(page.source, args);
      const updated = await updatePageSource({
        pageId: page.page.id,
        source: patched.source,
        baseVersionId: page.page.versionId,
        checkpoint: Boolean(args.checkpoint),
        checkpointLabel: args.checkpoint_label
          ? String(args.checkpoint_label)
          : null,
        context,
      });
      return {
        ...updated,
        replacement_count: patched.replacementCount,
      };
    }
    case "update_page": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      assertEditBase(page.page, args);
      const source = asString(args.source, "");
      if (!Boolean(args.allow_noop) && source === page.source) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Page source is unchanged. Pass allow_noop=true to save anyway.",
          400,
          {
            current_version_id: page.page.versionId,
            current_content_hash: page.page.contentHash,
          },
        );
      }
      return updatePageSource({
        pageId: page.page.id,
        source,
        baseVersionId: page.page.versionId,
        checkpoint: Boolean(args.checkpoint),
        checkpointLabel: args.checkpoint_label
          ? String(args.checkpoint_label)
          : null,
        context,
      });
    }
    case "get_page": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "read",
        args.workspace_id,
      );
      const include = normalizeInclude(args.include);
      const result: Record<string, unknown> = {
        page: page.page,
        url: absoluteUrl(context, `/p/${page.page.slugId}`),
      };
      if (include.has("source")) result.source = page.source;
      if (include.has("rendered")) {
        const rendered =
          page.page.sourceType === "html"
            ? { html: "", headings: [], frontmatter: {}, frontmatterText: "" }
            : await renderCachedMarkdown({
                pageId: page.page.id,
                contentHash: page.page.contentHash,
                source: page.source,
              });
        result.rendered = {
          page_id: page.page.id,
          content_hash: page.page.contentHash,
          source_type: page.page.sourceType,
          html: rendered.html,
          render_mode:
            page.page.sourceType === "html" ? "sandboxed_html" : "html",
          headings: rendered.headings,
          frontmatter: rendered.frontmatter,
          frontmatter_text: flattenFrontmatter(rendered.frontmatter),
        };
      }
      if (include.has("versions")) {
        const versions = pageService.listVersions(page.page.id);
        result.versions = versions.slice(0, 100);
        result.versions_truncated = versions.length > 100;
      }
      if (include.has("comments")) {
        const threads = await listPageComments(
          page.page.id,
          "all",
          context,
          page.page.workspaceId,
        );
        result.threads = threads.slice(0, 100);
        result.threads_truncated = threads.length > 100;
      }
      if (include.has("publication")) {
        assertPagePermission(context, page.page, "admin");
        result.publication = serializePublication({
          type: "page",
          page: page.page,
          slugId: page.page.slugId,
        });
      }
      return result;
    }
    case "list_page_versions": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "read",
        args.workspace_id,
      );
      return { versions: pageService.listVersions(page.page.id) };
    }
    case "create_page_snapshot": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      const updated = await pageService.updateSource({
        pageId: page.page.id,
        source: page.source,
        baseVersionId: page.page.versionId,
        checkpoint: true,
        checkpointLabel: args.label ? String(args.label) : "Manual snapshot",
      });
      reviewEventService.emit({
        workspaceId: page.page.workspaceId,
        pageId: page.page.id,
        type: "page.version_created",
        actorUserId: context.actor.user?.id ?? null,
        payload: {
          version_id: updated.page.versionId,
          label: args.label ?? null,
          source: "mcp",
        },
      });
      return {
        page_id: updated.page.id,
        version_id: updated.page.versionId,
        updated_at: updated.page.updatedAt,
        checkpoint_created: updated.checkpointCreated,
      };
    }
    case "restore_page_version": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      const versionId = asString(args.version_id);
      if (!versionId) {
        throw new AppError("VALIDATION_ERROR", "version_id is required.", 400);
      }
      const version = await pageService.getVersionSource(
        page.page.id,
        versionId,
      );
      const restored = await updatePageSource({
        pageId: page.page.id,
        source: version.source,
        baseVersionId: page.page.versionId,
        checkpoint: true,
        checkpointLabel: `Restored ${version.version.createdAt}`,
        context,
      });
      auditService.record({
        workspaceId: page.page.workspaceId,
        actorUserId: context.actor.user?.id ?? null,
        action: "page.version_restored",
        targetType: "page",
        targetId: page.page.id,
        metadata: {
          version_id: versionId,
          restored_version_id: restored.version_id,
        },
      });
      return restored;
    }
    case "upload_attachment": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      const attachment = await attachmentService.upload({
        page: page.page,
        filename: asString(args.filename),
        contentType: asString(args.content_type),
        base64Body: asString(args.base64_body),
      });
      reviewEventService.emit({
        workspaceId: page.page.workspaceId,
        pageId: page.page.id,
        type: "attachment.uploaded",
        actorUserId: null,
        payload: {
          attachment_id: attachment.id,
          filename: attachment.filename,
          source: "mcp",
        },
      });
      return {
        attachment,
        url: absoluteUrl(
          context,
          `/api/attachments/${attachment.id}?workspace_id=${encodeURIComponent(page.page.workspaceId)}`,
        ),
      };
    }
    case "validate_page_source":
      return validatePageSource(args, context);
    case "wait_for_review":
      return waitForReview(args, context);
    case "list_comments": {
      const status =
        args.status === "resolved" || args.status === "all"
          ? args.status
          : "open";
      return {
        threads: await listPageComments(
          asString(args.page_id),
          status,
          context,
          args.workspace_id,
        ),
      };
    }
    case "create_comment": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "comment",
        args.workspace_id,
      );
      const anchor = coerceCommentAnchor(args.anchor, {
        contentHash: page.page.contentHash,
      });
      if (anchor.sourceStart === null && anchor.selectedText.trim()) {
        const sourceStart = findAnchoredIndex(
          page.source,
          anchor.selectedText,
          anchor.prefixText,
          anchor.suffixText,
        );
        if (sourceStart >= 0) {
          anchor.sourceStart = sourceStart;
          anchor.sourceEnd = sourceStart + anchor.selectedText.length;
          anchor.selector = {
            ...(anchor.selector ?? {}),
            position: {
              ...(anchor.selector?.position ?? {}),
              sourceStart: anchor.sourceStart,
              sourceEnd: anchor.sourceEnd,
            },
          };
        }
      }
      const created = commentService.createThread({
        pageId: page.page.id,
        workspaceId: page.page.workspaceId,
        body: asString(args.body),
        authorUserId: context.actor.user?.id ?? null,
        anchor,
      });
      reviewEventService.emit({
        workspaceId: page.page.workspaceId,
        pageId: page.page.id,
        type: "comment.created",
        actorUserId: context.actor.user?.id ?? null,
        payload: { thread_id: created.thread.id, source: "mcp" },
      });
      scheduleIndexCommentThread(created.thread.id);
      return {
        ...created,
        page: {
          id: page.page.id,
          title: page.page.title,
          sourceType: page.page.sourceType,
          contentHash: page.page.contentHash,
          url: absoluteUrl(context, `/p/${page.page.slugId}`),
        },
      };
    }
    case "update_thread": {
      const { thread, page } = await getThreadPage(
        asString(args.thread_id),
        context,
        "comment",
        args.workspace_id,
      );
      if (
        (args.status === "resolved" && args.resolve === false) ||
        (args.status === "open" && args.resolve === true)
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          "status and resolve cannot request opposite thread states.",
          400,
        );
      }
      let reply = null;
      if (asString(args.body, "").trim()) {
        reply =
          args.agent_name || args.agent_model || args.agent_session_id
            ? commentService.reply(agentReplyInput(args))
            : commentService.reply({
                threadId: thread.thread.id,
                body: asString(args.body),
                authorType: "user",
                agent: null,
              });
        reviewEventService.emit({
          workspaceId: page.page.workspaceId,
          pageId: page.page.id,
          type: "comment.replied",
          actorUserId: context.actor.user?.id ?? null,
          payload: {
            thread_id: thread.thread.id,
            reply_id: reply.id,
            source: "mcp",
          },
        });
      }
      let updated =
        commentService.getThread(thread.thread.id)?.thread ?? thread.thread;
      const shouldResolve = args.resolve === true || args.status === "resolved";
      const shouldOpen = args.status === "open" || args.resolve === false;
      if (shouldResolve && updated.status !== "resolved") {
        updated = commentService.resolve(thread.thread.id);
        reviewEventService.emit({
          workspaceId: page.page.workspaceId,
          pageId: page.page.id,
          type: "comment.resolved",
          actorUserId: context.actor.user?.id ?? null,
          payload: { thread_id: updated.id, source: "mcp" },
        });
      } else if (shouldOpen && updated.status !== "open") {
        updated = commentService.unresolve(thread.thread.id);
        reviewEventService.emit({
          workspaceId: page.page.workspaceId,
          pageId: page.page.id,
          type: "comment.unresolved",
          actorUserId: context.actor.user?.id ?? null,
          payload: { thread_id: updated.id, source: "mcp" },
        });
      }
      scheduleIndexCommentThread(thread.thread.id);
      const enriched = commentService.getThread(thread.thread.id);
      return {
        reply,
        thread: enriched?.thread ?? updated,
        replies: enriched?.replies ?? [],
      };
    }
    case "update_comment_anchor": {
      const { thread, page } = await getThreadPage(
        asString(args.thread_id),
        context,
        "comment",
        args.workspace_id,
      );
      const updated = commentService.updateAnchor({
        threadId: thread.thread.id,
        anchor: coerceCommentAnchor(args.anchor, {
          contentHash: page.page.contentHash,
          selectedText: thread.anchor.selectedText,
          kind: thread.anchor.kind,
          surface: thread.anchor.surface,
          confidence: "fuzzy",
        }),
      });
      scheduleIndexCommentThread(thread.thread.id);
      return {
        anchor: updated,
        thread: commentService.getThread(thread.thread.id),
      };
    }
    case "delete_thread": {
      const { thread } = await getThreadPage(
        asString(args.thread_id),
        context,
        "admin",
        args.workspace_id,
      );
      const deleted = commentService.deleteThread(thread.thread.id);
      await removeSearchResource("comment_thread", deleted.id);
      return { thread: deleted };
    }
    case "list_review_events": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "read");
      if (args.page_id) {
        await getExistingPage(
          String(args.page_id),
          context,
          "read",
          workspaceId,
        );
      }
      return {
        events: reviewEventService.list({
          workspaceId,
          pageId: args.page_id ? String(args.page_id) : undefined,
          afterId: args.after_id ? String(args.after_id) : null,
          limit: clampNumber(args.limit, 50, 1, 200),
        }),
      };
    }
    case "publication_apply": {
      const resourceType = args.resource_type === "folder" ? "folder" : "page";
      const publicationId = asString(args.publication_id, "");
      const requestedPermission =
        args.permission === "edit" ||
        args.permission === "comment" ||
        args.permission === "view"
          ? args.permission
          : undefined;
      const permission = requestedPermission ?? "view";
      const password =
        args.clear_password === true
          ? null
          : args.password === undefined
            ? undefined
            : args.password
              ? String(args.password)
              : null;
      if (password !== undefined) assertPublicationPasswordPolicy(password);
      if (publicationId) {
        const publication = await assertPublicationPermission(
          publicationId,
          context,
          args.workspace_id,
        );
        const updated = await publicationService.update(publication.id, {
          permission: requestedPermission,
          expiresAt:
            args.clear_expires_at === true
              ? null
              : args.expires_at === undefined
                ? undefined
                : args.expires_at
                  ? String(args.expires_at)
                  : null,
          password,
          indexingEnabled:
            args.indexing_enabled === undefined
              ? undefined
              : Boolean(args.indexing_enabled),
        });
        reviewEventService.emit({
          workspaceId: updated.workspaceId,
          pageId: updated.resourceType === "page" ? updated.resourceId : null,
          type: "publication.updated",
          actorUserId: context.actor.user?.id ?? null,
          payload: { publication_id: updated.id, source: "mcp" },
        });
        return { publication_id: updated.id, publication: updated };
      }
      if (resourceType === "folder") {
        const folder = await getExistingFolder(
          asString(args.resource_id),
          context,
          "admin",
          args.workspace_id,
        );
        const publication = await publicationService.upsert({
          workspaceId: folder.workspaceId,
          resourceType: "folder",
          resourceId: folder.id,
          permission,
          expiresAt:
            args.expires_at === undefined
              ? undefined
              : args.expires_at
                ? String(args.expires_at)
                : null,
          password,
          indexingEnabled:
            args.indexing_enabled === undefined
              ? undefined
              : Boolean(args.indexing_enabled),
        });
        return {
          publication_id: publication.id,
          publication,
          url: absoluteUrl(context, `/f/${folder.slugId}`),
        };
      }
      const page = await getExistingPage(
        asString(args.resource_id),
        context,
        "admin",
        args.workspace_id,
      );
      const publication = await publicationService.upsert({
        workspaceId: page.page.workspaceId,
        resourceType: "page",
        resourceId: page.page.id,
        permission,
        expiresAt:
          args.expires_at === undefined
            ? undefined
            : args.expires_at
              ? String(args.expires_at)
              : null,
        password,
        indexingEnabled:
          args.indexing_enabled === undefined
            ? undefined
            : Boolean(args.indexing_enabled),
      });
      return {
        publication_id: publication.id,
        publication,
        url: absoluteUrl(context, `/p/${page.page.slugId}`),
      };
    }
    case "publication_delete": {
      const publication = await assertPublicationPermission(
        asString(args.publication_id),
        context,
        args.workspace_id,
      );
      const revoked = publicationService.revoke(publication.id);
      reviewEventService.emit({
        workspaceId: revoked.workspaceId,
        pageId: revoked.resourceType === "page" ? revoked.resourceId : null,
        type: "publication.revoked",
        actorUserId: context.actor.user?.id ?? null,
        payload: { publication_id: revoked.id, source: "mcp" },
      });
      return { publication: revoked };
    }
    case "search_workspace": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "read");
      return {
        results: (
          await searchIndexedResources(workspaceId, asString(args.query), {
            limit: clampNumber(args.limit, 10, 1, 50),
            type: normalizeSearchType(args.type),
          })
        ).filter((result) => canReadSearchResult(context, workspaceId, result)),
      };
    }
    case "list_workspace": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "read");
      const nav = buildWorkspaceNavigation(
        {
          ...context.actor,
          sessionId: null,
          devFallback: false,
          authMode: "mcp_session",
        },
        workspaceId,
      );
      const depth =
        args.depth === undefined || args.depth === null
          ? null
          : clampNumber(args.depth, 0, 0, 20);
      const folderId = asString(args.folder_id, "");
      const updatedAfter = asString(args.updated_after, "");
      const filtered = filterWorkspaceNavigation(nav, {
        folderId,
        depth,
        updatedAfter,
      });
      if (!filtered) {
        throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
      }
      const folders = filtered.folders;
      const pages = filtered.pages;
      return {
        workspace_id: workspaceId,
        tree_version: nav.treeVersion,
        page_count: nav.visiblePages.length,
        folder_count: nav.visibleFolders.length,
        counts:
          args.include_counts === true
            ? {
                pages: nav.visiblePages.length,
                folders: nav.visibleFolders.length,
              }
            : undefined,
        folders,
        pages: pages.map((page) => ({
          id: page.id,
          folderPath: page.folderPath,
          title: page.title,
          slugId: page.slugId,
          url: absoluteUrl(context, `/p/${page.slugId}`),
        })),
        partial: Boolean(folderId || depth || updatedAfter),
      };
    }
    case "move_page": {
      const page = await getExistingPage(
        asString(args.page_id),
        context,
        "write",
        args.workspace_id,
      );
      const folderPath =
        args.folder_path === undefined
          ? undefined
          : String(args.folder_path).replace(/^\/+|\/+$/g, "");
      if (
        folderPath &&
        !workspaceService
          .listFolders(page.page.workspaceId)
          .some((folder) => folder.path === folderPath)
      ) {
        throw new AppError(
          "FOLDER_NOT_FOUND",
          "Folder was not found in this workspace.",
          404,
        );
      }
      const updated = pageService.movePage({
        pageId: asString(args.page_id),
        title: args.title === undefined ? undefined : String(args.title),
        folderPath,
      });
      scheduleIndexPage(updated.id);
      reviewEventService.emit({
        workspaceId: updated.workspaceId,
        pageId: updated.id,
        type: "page.moved",
        actorUserId: null,
        payload: {
          page_id: updated.id,
          title: updated.title,
          folder_path: updated.folderPath,
          source: "mcp",
        },
      });
      return {
        page: updated,
        url: absoluteUrl(context, `/p/${updated.slugId}`),
      };
    }
    case "invite_workspace_member": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "admin");
      const role =
        args.role === "admin" ||
        args.role === "editor" ||
        args.role === "commenter" ||
        args.role === "reader"
          ? args.role
          : "reader";
      const user = workspaceService.createUser({
        email: asString(args.email),
        displayName: args.display_name
          ? String(args.display_name)
          : asString(args.email),
        role: "user",
      });
      const existingMember = workspaceService.getMember(workspaceId, user.id);
      const member = workspaceService.addMember({
        workspaceId,
        userId: user.id,
        role,
      });
      const magic = await authService.createMagicLink({
        email: user.email,
        redirectTo: "/app",
      });
      const verifyUrl = absoluteUrl(
        context,
        `/auth/magic-link#token=${encodeURIComponent(magic.rawToken)}`,
      );
      const workspace = workspaceService.getWorkspace(workspaceId);
      let delivery: Record<string, unknown> | null = null;
      let deliveryWarning: string | null = null;
      try {
        delivery = await sendMagicLinkEmail({
          to: user.email,
          verifyUrl,
          workspaceName: workspace?.name ?? null,
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "EMAIL_NOT_CONFIGURED"
        ) {
          delivery = { provider: "manual", sent: false };
          deliveryWarning =
            "Email is not configured. No sign-in link was returned to the MCP client.";
        } else {
          throw error;
        }
      }
      const devVerifyUrl =
        import.meta.env.DEV &&
        process.env.VPG_RETURN_VERIFY_URL_IN_INVITE === "true"
          ? verifyUrl
          : null;
      auditService.record({
        workspaceId,
        actorUserId: context.actor.user?.id ?? null,
        action: existingMember
          ? "workspace.member_reinvited"
          : "workspace.member_invited",
        targetType: "user",
        targetId: user.id,
        metadata: {
          role,
          email: user.email,
          existing_member: Boolean(existingMember),
          delivery_warning: deliveryWarning,
          returned_verify_url: Boolean(devVerifyUrl),
          source: "mcp",
        },
      });
      return {
        user,
        member,
        magic_link_created: true,
        delivery,
        delivery_warning: deliveryWarning,
        dev_verify_url: devVerifyUrl,
      };
    }
    case "list_templates": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "read");
      const category = args.category ? String(args.category) : null;
      const templates = templateService
        .listTemplates(workspaceId)
        .filter((template) => !category || template.category === category)
        .map((template) => ({
          id: template.id,
          slug: template.slug,
          name: template.name,
          description: template.description,
          category: template.category,
          source_type: template.sourceType,
          properties: template.properties,
          is_builtin: template.isBuiltin,
        }));
      return { templates };
    }
    case "get_template": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "read");
      const template = resolveTemplate(workspaceId, asString(args.template));
      const withSource = await templateService.getTemplateWithSource(
        template.id,
      );
      if (!withSource) {
        throw new AppError(
          "PAGE_NOT_FOUND",
          "Template source was not found.",
          404,
        );
      }
      return {
        template: {
          ...serializeMcpTemplate(withSource.template),
          content_hash: withSource.template.contentHash,
        },
        source: withSource.source,
        builder: templateBuilderFromMarkdown(withSource.source),
      };
    }
    case "create_template": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "write");
      const source = templateBuilderToMarkdown(asTemplateBuilder(args.builder));
      const created = await templateService.createTemplate({
        workspaceId,
        name: asString(args.name),
        slug: optionalString(args.slug),
        description: optionalString(args.description) ?? "",
        category: optionalString(args.category) ?? "general",
        sourceType: args.source_type === "mdx" ? "mdx" : "markdown",
        source,
        properties: asTemplateProperties(args.properties),
        createdBy: context.actor.user?.id ?? null,
      });
      auditService.record({
        workspaceId,
        actorUserId: context.actor.user?.id ?? null,
        action: "template.created",
        targetType: "template",
        targetId: created.template.id,
        metadata: {
          slug: created.template.slug,
          name: created.template.name,
          source: "mcp",
        },
      });
      return {
        template: serializeMcpTemplate(created.template),
        source: created.source,
        builder: templateBuilderFromMarkdown(created.source),
      };
    }
    case "update_template": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "write");
      const template = resolveTemplate(workspaceId, asString(args.template));
      const source =
        args.builder === undefined
          ? undefined
          : templateBuilderToMarkdown(asTemplateBuilder(args.builder));
      const updated = await templateService.updateTemplate({
        templateId: template.id,
        name: optionalString(args.name),
        slug: optionalString(args.slug),
        description: optionalString(args.description),
        category: optionalString(args.category),
        sourceType:
          args.source_type === undefined
            ? undefined
            : args.source_type === "mdx"
              ? "mdx"
              : "markdown",
        source,
        properties: asTemplateProperties(args.properties),
        updatedBy: context.actor.user?.id ?? null,
      });
      auditService.record({
        workspaceId: updated.template.workspaceId,
        actorUserId: context.actor.user?.id ?? null,
        action: "template.updated",
        targetType: "template",
        targetId: updated.template.id,
        metadata: {
          slug: updated.template.slug,
          name: updated.template.name,
          source: "mcp",
        },
      });
      return {
        template: serializeMcpTemplate(updated.template),
        source: updated.source,
        builder: templateBuilderFromMarkdown(updated.source),
      };
    }
    case "render_template": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "read");
      const template = resolveTemplate(workspaceId, asString(args.template));
      const properties =
        args.properties && typeof args.properties === "object"
          ? (args.properties as Record<string, unknown>)
          : {};
      const rendered = await templateService.render({
        templateId: template.id,
        title: asString(args.title),
        properties,
      });
      return {
        template_id: rendered.template.id,
        slug: rendered.template.slug,
        source: rendered.source,
        body: rendered.body,
        frontmatter: rendered.frontmatter,
      };
    }
    case "create_page_from_template": {
      const workspaceId = requiredWorkspaceId(args.workspace_id);
      assertWorkspacePermission(context, workspaceId, "write");
      const template = resolveTemplate(workspaceId, asString(args.template));
      const title = asString(args.title);
      const properties =
        args.properties && typeof args.properties === "object"
          ? (args.properties as Record<string, unknown>)
          : {};
      const rendered = await templateService.render({
        templateId: template.id,
        title,
        properties,
      });
      const created = await pageService.createPage({
        workspaceId,
        folderPath: args.folder_path ? String(args.folder_path) : "",
        title,
        sourceType: rendered.template.sourceType === "mdx" ? "mdx" : "markdown",
        source: rendered.source,
      });
      scheduleIndexPage(created.page.id);
      auditService.record({
        workspaceId: created.page.workspaceId,
        actorUserId: context.actor.user?.id ?? null,
        action: "page.created_from_template",
        targetType: "page",
        targetId: created.page.id,
        metadata: {
          template_id: template.id,
          template_slug: template.slug,
          title: created.page.title,
          folder_path: created.page.folderPath,
          source: "mcp",
        },
      });
      reviewEventService.emit({
        workspaceId: created.page.workspaceId,
        pageId: created.page.id,
        type: "page.created",
        actorUserId: context.actor.user?.id ?? null,
        payload: {
          page_id: created.page.id,
          version_id: created.page.versionId,
          template_slug: template.slug,
          source: "mcp",
        },
      });
      return pageMutationResult(created.page, context);
    }
    case "list_workspaces": {
      const user = context.actor.user;
      if (!user) {
        throw new AppError("AUTH_REQUIRED", "Authentication is required.", 401);
      }
      const workspaces = workspaceService
        .listWorkspacesForUser(user.id)
        .map((workspace) => {
          const member = workspaceService.getMember(workspace.id, user.id);
          return {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            role: member?.role ?? null,
          };
        });
      return { workspaces };
    }
    case "whoami": {
      const user = context.actor.user;
      if (!user) {
        return {
          user: null,
          auth_mode: context.actor.authMode,
          workspaces: [],
          workspace_id: context.actor.workspaceId,
        };
      }
      const workspaces = workspaceService
        .listWorkspacesForUser(user.id)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
        }));
      return {
        user: {
          id: user.id,
          email: user.email,
          display_name: user.displayName ?? null,
          role: user.role,
        },
        auth_mode: context.actor.authMode,
        workspace_id: context.actor.workspaceId,
        workspaces,
      };
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function serializeMcpTemplate(template: TemplateRecord) {
  return {
    id: template.id,
    slug: template.slug,
    name: template.name,
    description: template.description,
    category: template.category,
    source_type: template.sourceType,
    version_id: template.versionId,
    properties: template.properties,
    is_builtin: template.isBuiltin,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  };
}

function asTemplateProperties(input: unknown): TemplateProperty[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template properties must be an array.",
      400,
    );
  }
  return input as TemplateProperty[];
}

function asTemplateBuilder(input: unknown): TemplateBuilderDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template builder must be an object with title, intro, and sections.",
      400,
    );
  }
  const record = input as Record<string, unknown>;
  const sections = Array.isArray(record.sections) ? record.sections : [];
  return {
    title: optionalString(record.title),
    intro: optionalString(record.intro),
    sections: sections.map((entry) => {
      const section =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      return {
        level:
          section.level === 3 || section.level === 4
            ? (section.level as TemplateBuilderHeadingLevel)
            : 2,
        heading: optionalString(section.heading) ?? "",
        helpText:
          optionalString(section.help_text) ??
          optionalString(section.helpText) ??
          "",
        guidance: optionalString(section.guidance) ?? "",
        body: optionalString(section.body) ?? "",
      };
    }),
  };
}

function resolveTemplate(workspaceId: string, identifier: string) {
  if (!identifier) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template identifier is required.",
      400,
    );
  }
  const direct = identifier.startsWith("tpl_")
    ? templateService.getTemplate(identifier)
    : null;
  const bySlug = direct
    ? null
    : templateService.getTemplateBySlug(workspaceId, identifier);
  const template = direct ?? bySlug;
  if (!template || template.workspaceId !== workspaceId) {
    throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
  }
  return template;
}

async function updatePageSource(input: {
  pageId: string;
  source: string;
  baseVersionId: string;
  checkpoint: boolean;
  checkpointLabel: string | null;
  context: McpToolContext;
}) {
  const updated = await pageService.updateSource({
    pageId: input.pageId,
    source: input.source,
    baseVersionId: input.baseVersionId,
    checkpoint: input.checkpoint,
    checkpointLabel: input.checkpointLabel,
  });
  scheduleIndexPage(updated.page.id);
  reviewEventService.emit({
    workspaceId: updated.page.workspaceId,
    pageId: updated.page.id,
    type: updated.checkpointCreated ? "page.version_created" : "page.updated",
    actorUserId: null,
    payload: {
      version_id: updated.page.versionId,
      content_hash: updated.page.contentHash,
      checkpoint_created: updated.checkpointCreated,
      changed: updated.changed,
      source: "mcp",
    },
  });
  return {
    page_id: updated.page.id,
    slug_id: updated.page.slugId,
    url: absoluteUrl(input.context, `/p/${updated.page.slugId}`),
    version_id: updated.page.versionId,
    content_hash: updated.page.contentHash,
    checkpoint_created: updated.checkpointCreated,
    changed: updated.changed,
  };
}

async function waitForReview(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const page = await getExistingPage(
    asString(args.page_id),
    context,
    "read",
    args.workspace_id,
  );
  const waitKey = waitForReviewKey(context, page.page.id);
  if (activeWaitForReviewCalls.has(waitKey)) {
    throw new AppError(
      "RATE_LIMITED",
      "Only one wait_for_review call may be active per actor and page.",
      429,
    );
  }
  activeWaitForReviewCalls.add(waitKey);
  try {
    return await waitForReviewLoop(args, page.page.id);
  } finally {
    activeWaitForReviewCalls.delete(waitKey);
  }
}

async function waitForReviewLoop(
  args: Record<string, unknown>,
  pageId: string,
) {
  const until =
    args.until === "first_response" ||
    args.until === "all_threads_resolved" ||
    args.until === "timeout"
      ? args.until
      : "new_comment";
  const timeoutMs = clampNumber(args.timeout_ms, 600_000, 0, 600_000);
  const pollIntervalMs = clampNumber(args.poll_interval_ms, 1_000, 250, 5_000);
  const afterId = args.after_event_id ? String(args.after_event_id) : null;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const events = reviewEventService.list({
      pageId,
      afterId,
      limit: 200,
    });
    const threads = commentService.listForPage(pageId, "all");
    const openThreads = threads.filter(
      (thread) => thread.thread.status === "open",
    );
    const commentEvents = events.filter(
      (event) =>
        event.type === "comment.created" || event.type === "comment.replied",
    );

    if (
      until === "new_comment" &&
      (commentEvents.some((event) => event.type === "comment.created") ||
        (!afterId && threads.length > 0))
    ) {
      return waitResult("matched", until, events, threads);
    }
    if (
      until === "first_response" &&
      (commentEvents.length > 0 || (!afterId && threads.length > 0))
    ) {
      return waitResult("matched", until, events, threads);
    }
    if (
      until === "all_threads_resolved" &&
      threads.length > 0 &&
      openThreads.length === 0
    ) {
      return waitResult("matched", until, events, threads);
    }
    if (until === "timeout" || Date.now() >= deadline) {
      return waitResult("timeout", until, events, threads);
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

function waitForReviewKey(context: McpToolContext, pageId: string) {
  return [
    context.actor.authMode,
    context.actor.user?.id ?? context.actor.workspaceId ?? "anonymous",
    pageId,
  ].join(":");
}

function waitResult(
  status: "matched" | "timeout",
  until: string,
  events: unknown[],
  threads: unknown[],
) {
  return {
    status,
    until,
    events,
    threads,
    event_count: events.length,
    thread_count: threads.length,
  };
}

async function validatePageSource(
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const pageId = args.page_id ? String(args.page_id) : null;
  const workspaceId = requiredWorkspaceId(args.workspace_id);
  const page = pageId
    ? await getExistingPage(pageId, context, "read", workspaceId)
    : null;
  if (!page) assertWorkspacePermission(context, workspaceId, "read");
  const source =
    args.source === undefined ? (page?.source ?? "") : String(args.source);
  const sourceType =
    args.source_type === "mdx" || args.source_type === "html"
      ? args.source_type
      : (page?.page.sourceType ?? "markdown");
  return validateEditableSource({ source, sourceType });
}

function patchSource(source: string, args: Record<string, unknown>) {
  const find = asString(args.find);
  if (!find) throw new AppError("VALIDATION_ERROR", "find is required.", 400);

  const replace = asString(args.replace, "");
  const replaceAll = Boolean(args.replace_all);
  const parts = source.split(find);
  const replacementCount = parts.length - 1;
  if (replacementCount === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Text to replace was not found in the live page source.",
      400,
    );
  }

  const expected =
    args.expected_replacements === undefined
      ? replaceAll
        ? replacementCount
        : 1
      : Number(args.expected_replacements);
  if (!Number.isFinite(expected) || expected < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "expected_replacements must be a positive number.",
      400,
    );
  }
  if (replacementCount !== expected) {
    throw new AppError(
      "CONFLICT",
      "Replacement count did not match expected_replacements.",
      409,
      {
        replacement_count: replacementCount,
        expected_replacements: expected,
      },
    );
  }

  return {
    replacementCount,
    source: replaceAll ? parts.join(replace) : source.replace(find, replace),
  };
}

function assertEditBase(
  page: { versionId: string; contentHash: string; updatedAt: string },
  args: Record<string, unknown>,
) {
  const baseVersionId = asString(args.base_version_id);
  if (page.versionId !== baseVersionId) {
    throw new AppError(
      "CONFLICT",
      "Page source has changed since it was loaded.",
      409,
      {
        current_version_id: page.versionId,
        current_content_hash: page.contentHash,
        updated_at: page.updatedAt,
      },
    );
  }
  if (
    args.base_content_hash &&
    page.contentHash !== String(args.base_content_hash)
  ) {
    throw new AppError(
      "CONFLICT",
      "Page content hash has changed since it was loaded.",
      409,
      {
        current_version_id: page.versionId,
        current_content_hash: page.contentHash,
        updated_at: page.updatedAt,
      },
    );
  }
}

function agentReplyInput(args: Record<string, unknown>) {
  return {
    threadId: asString(args.thread_id),
    body: asString(args.body),
    authorType: args.agent_name ? ("agent" as const) : ("user" as const),
    agent: args.agent_name
      ? {
          name: String(args.agent_name),
          model: asString(args.agent_model, "unknown"),
          sessionId: asString(args.agent_session_id, "agt_mcp"),
        }
      : null,
  };
}

async function getExistingPage(
  pageId: string,
  context?: McpToolContext,
  required: PermissionLevel = "read",
  workspaceValue?: unknown,
) {
  const page =
    (await pageService.getPage(pageId)) ??
    (await pageService.getPageBySlugId(pageId));
  if (!page) throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
  if (arguments.length >= 4) {
    assertMcpWorkspaceMatches(workspaceValue, page.page.workspaceId, "page");
  }
  if (context) {
    assertPagePermission(context, page.page, required);
  }
  return page;
}

async function getExistingFolder(
  folderId: string,
  context?: McpToolContext,
  required: PermissionLevel = "read",
  workspaceValue?: unknown,
) {
  const folder = workspaceService.getFolder(folderId);
  if (!folder)
    throw new AppError("FOLDER_NOT_FOUND", "Folder was not found.", 404);
  if (arguments.length >= 4) {
    assertMcpWorkspaceMatches(workspaceValue, folder.workspaceId, "folder");
  }
  if (context) {
    const member = context.actor.user
      ? workspaceService.getMember(folder.workspaceId, context.actor.user.id)
      : null;
    const permission = permissionService.resolve({
      user: context.actor.user,
      member,
      workspaceId: folder.workspaceId,
      folderAncestorIds: workspaceService
        .folderAncestors(folder.id)
        .map((ancestor) => ancestor.id),
    });
    if (!hasPermission(permission, required)) {
      throw new AppError(
        "PERMISSION_DENIED",
        "MCP session does not have permission for this folder.",
        403,
      );
    }
  }
  return folder;
}

async function getThreadPage(
  threadId: string,
  context: McpToolContext,
  required: PermissionLevel,
  workspaceValue: unknown,
) {
  const thread = commentService.getThread(threadId);
  if (!thread)
    throw new AppError(
      "THREAD_NOT_FOUND",
      "Comment thread was not found.",
      404,
    );
  const page = await getExistingPage(
    thread.thread.pageId,
    context,
    required,
    workspaceValue,
  );
  return { thread, page };
}

function listResources(context: McpToolContext) {
  const readableWorkspaces = context.actor.user
    ? workspaceService
        .listWorkspacesForUser(context.actor.user.id)
        .filter((workspace) => canUseWorkspace(context, workspace.id, "read"))
    : [];
  return [
    ...skillResources.map(([uri, name]) => ({
      uri,
      name,
      description:
        "Portable VegaStack Pages agent skill material for MCP and CLI workflows",
      mimeType: "text/markdown",
    })),
    ...pageService
      .listPages()
      .filter((page) => canReadPage(context, page))
      .map((page) => ({
        uri: `vpg://pages/${page.id}`,
        name: page.title,
        description: `${page.sourceType.toUpperCase()} source for ${page.folderPath ? `${page.folderPath}/` : ""}${page.title}`,
        mimeType: page.sourceType === "html" ? "text/html" : "text/markdown",
      })),
    ...readableWorkspaces.map((workspace) => ({
      uri: `vpg://workspaces/${workspace.id}/tree`,
      name: `${workspace.name} tree`,
      description: "Workspace folder and page tree",
      mimeType: "application/json",
    })),
  ];
}

async function readResource(uri: string, context: McpToolContext) {
  const skill = skillResources.find(([resourceUri]) => resourceUri === uri);
  if (skill) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: skill[2],
        },
      ],
    };
  }
  const pageMatch = /^vpg:\/\/pages\/([^/]+)$/.exec(uri);
  if (pageMatch) {
    const page = await getExistingPage(pageMatch[1]!, context, "read");
    return {
      contents: [
        {
          uri,
          mimeType:
            page.page.sourceType === "html" ? "text/html" : "text/markdown",
          text: page.source,
        },
      ],
    };
  }
  const treeMatch = /^vpg:\/\/workspaces\/([^/]+)\/tree$/.exec(uri);
  if (treeMatch) {
    const workspaceId = treeMatch[1]!;
    assertWorkspacePermission(context, workspaceId, "read");
    const pages = pageService
      .listPages(workspaceId)
      .filter((page) => canReadPage(context, page))
      .map((page) => ({
        id: page.id,
        folderPath: page.folderPath,
        title: page.title,
        slugId: page.slugId,
      }));
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            workspaceService.tree({ workspaceId, pages }),
            null,
            2,
          ),
        },
      ],
    };
  }
  throw new AppError("PAGE_NOT_FOUND", "MCP resource was not found.", 404);
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
      "Use list_comments and list_review_events first.",
      "If you created the page, publish it with comment access, tell the user the URL, then wait up to 10 minutes with wait_for_review timeout_ms=600000.",
      "When comments arrive, act on them immediately instead of asking the user to paste them back into chat.",
      "When changing source, call prepare_page_edit before patch_page or update_page.",
      "Use update_thread with agent metadata for each resolved thread.",
    ].join("\n"),
    vegastack_edit_page_safely: [
      `Edit VegaStack Pages page ${pageId}: ${change}`,
      "Call prepare_page_edit, validate the intended source, then prefer patch_page with expected_replacements.",
      "If the base version or content hash is stale, refetch and reapply the change.",
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

function canUseWorkspace(
  context: McpToolContext,
  workspaceId: string,
  required: PermissionLevel,
) {
  if (context.actor.workspaceId && context.actor.workspaceId !== workspaceId)
    return false;
  const member = context.actor.user
    ? workspaceService.getMember(workspaceId, context.actor.user.id)
    : null;
  const permission = permissionService.resolve({
    user: context.actor.user,
    member,
    workspaceId,
  });
  return hasPermission(permission, required);
}

function assertWorkspacePermission(
  context: McpToolContext,
  workspaceId: string,
  required: PermissionLevel,
) {
  if (!canUseWorkspace(context, workspaceId, required)) {
    throw new AppError(
      "PERMISSION_DENIED",
      "MCP session does not have permission for this workspace.",
      403,
      {
        workspace_id: workspaceId,
        required,
      },
    );
  }
}

function folderAncestorIds(workspaceId: string, folderPath: string) {
  const folder = workspaceService
    .listFolders(workspaceId)
    .find((candidate) => candidate.path === folderPath);
  return folder
    ? workspaceService.folderAncestors(folder.id).map((ancestor) => ancestor.id)
    : [];
}

function canReadPage(
  context: McpToolContext,
  page: { id: string; workspaceId: string; folderPath: string },
) {
  return canUsePage(context, page, "read");
}

function canReadSearchResult(
  context: McpToolContext,
  workspaceId: string,
  result: Awaited<ReturnType<typeof searchIndexedResources>>[number],
) {
  if (result.type === "folder") {
    const folder = result.folderId
      ? workspaceService.getFolder(result.folderId)
      : null;
    return folder ? canUseFolder(context, folder, "read") : false;
  }
  const pageId = result.pageId;
  if (!pageId) return false;
  const page = pageService
    .listPages(workspaceId)
    .find((candidate) => candidate.id === pageId);
  return page ? canReadPage(context, page) : false;
}

function canUseFolder(
  context: McpToolContext,
  folder: { id: string; workspaceId: string },
  required: PermissionLevel,
) {
  if (
    context.actor.workspaceId &&
    context.actor.workspaceId !== folder.workspaceId
  )
    return false;
  const member = context.actor.user
    ? workspaceService.getMember(folder.workspaceId, context.actor.user.id)
    : null;
  const permission = permissionService.resolve({
    user: context.actor.user,
    member,
    workspaceId: folder.workspaceId,
    folderAncestorIds: workspaceService
      .folderAncestors(folder.id)
      .map((ancestor) => ancestor.id),
  });
  return hasPermission(permission, required);
}

function canUsePage(
  context: McpToolContext,
  page: { id: string; workspaceId: string; folderPath: string },
  required: PermissionLevel,
) {
  if (
    context.actor.workspaceId &&
    context.actor.workspaceId !== page.workspaceId
  )
    return false;
  const member = context.actor.user
    ? workspaceService.getMember(page.workspaceId, context.actor.user.id)
    : null;
  const permission = permissionService.resolve({
    user: context.actor.user,
    member,
    workspaceId: page.workspaceId,
    folderAncestorIds: folderAncestorIds(page.workspaceId, page.folderPath),
    pageId: page.id,
  });
  return hasPermission(permission, required);
}

function assertPagePermission(
  context: McpToolContext,
  page: { id: string; workspaceId: string; folderPath: string },
  required: PermissionLevel,
) {
  if (!canUsePage(context, page, required)) {
    throw new AppError(
      "PERMISSION_DENIED",
      "MCP session does not have permission for this page.",
      403,
      {
        page_id: page.id,
        required,
      },
    );
  }
}

async function assertPublicationPermission(
  publicationId: string,
  context: McpToolContext,
  workspaceValue: unknown,
) {
  const publication = publicationService.get(publicationId);
  if (!publication)
    throw new AppError(
      "PUBLICATION_NOT_FOUND",
      "Publication was not found.",
      404,
    );
  if (publication.resourceType === "page") {
    await getExistingPage(
      publication.resourceId,
      context,
      "admin",
      workspaceValue,
    );
  } else {
    await getExistingFolder(
      publication.resourceId,
      context,
      "admin",
      workspaceValue,
    );
  }
  return publication;
}

async function listPageComments(
  pageId: string,
  status: "open" | "resolved" | "all",
  context: McpToolContext,
  workspaceValue: unknown,
) {
  const page = await getExistingPage(pageId, context, "read", workspaceValue);
  return commentService.listForPage(pageId, status).map((thread) => ({
    ...thread,
    page: {
      id: page.page.id,
      title: page.page.title,
      slugId: page.page.slugId,
      sourceType: page.page.sourceType,
      contentHash: page.page.contentHash,
      url: absoluteUrl(context, `/p/${page.page.slugId}`),
    },
    anchor_context: {
      kind: thread.anchor.kind,
      surface: thread.anchor.surface,
      confidence: thread.anchor.confidence,
      selectedText: thread.anchor.selectedText,
      prefixText: thread.anchor.prefixText,
      suffixText: thread.anchor.suffixText,
      sourceStart: thread.anchor.sourceStart,
      sourceEnd: thread.anchor.sourceEnd,
      renderedDomPath: thread.anchor.renderedDomPath ?? null,
      selector: thread.anchor.selector ?? null,
      needsPlacement:
        thread.anchor.confidence === "fuzzy" ||
        thread.anchor.confidence === "stale",
    },
  }));
}

function findAnchoredIndex(
  text: string,
  selectedText: string,
  prefixText: string,
  suffixText: string,
) {
  if (!text || !selectedText) return -1;
  let bestIndex = text.indexOf(selectedText);
  let bestScore = bestIndex >= 0 ? 0 : -1;
  let index = bestIndex;
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - prefixText.length), index);
    const suffix = text.slice(
      index + selectedText.length,
      index + selectedText.length + suffixText.length,
    );
    const score =
      commonSuffixLength(prefix, prefixText) +
      commonPrefixLength(suffix, suffixText);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = text.indexOf(selectedText, index + selectedText.length);
  }
  return bestIndex;
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

function commonSuffixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (
    count < limit &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
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

async function validateAuth(
  request: Request,
  options: { fast?: boolean } = {},
): Promise<McpActor> {
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
      ? workspaceService.getUserByEmail(configuredEmail)
      : devAutoLoginUser();
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
      user,
      authMode: "static_token",
      workspaceId: staticWorkspaceId,
    };
  }

  if (bearer) {
    const mcpSession = options.fast
      ? await getMcpSessionFast(bearer)
      : await getMcpSession(bearer);
    const mcpUser = mcpSession
      ? options.fast
        ? await getUserFast(mcpSession.userId)
        : workspaceService.getUser(mcpSession.userId)
      : null;
    if (mcpSession && (mcpUser || options.fast)) {
      return {
        user: mcpUser,
        userId: mcpSession.userId,
        authMode: "session",
        workspaceId: mcpSession.workspaceId,
      };
    }
  }

  if (!authRequired) {
    const devUser = devAutoLoginUser();
    return {
      user: devUser,
      userId: devUser?.id ?? null,
      authMode: devUser ? "session" : "anonymous",
      workspaceId: null,
    };
  }

  throw new AppError("AUTH_REQUIRED", "MCP bearer token is required.", 401);
}

function hydrateActorUser(actor: McpActor, options: { reload?: boolean } = {}) {
  if (actor.user && !options.reload) return;
  if (!actor.userId) return;
  actor.user = workspaceService.getUser(actor.userId);
  if (!actor.user) {
    throw new AppError("AUTH_REQUIRED", "MCP session user was not found.", 401);
  }
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

function absoluteUrl(context: McpToolContext, path: string) {
  return new URL(path, context.requestUrl).toString();
}

function pageMutationResult(
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function normalizeSearchType(value: unknown): SearchResourceType | "all" {
  return value === "page" || value === "folder" || value === "comment_thread"
    ? value
    : value === "comment"
      ? "comment_thread"
      : "all";
}

function normalizeInclude(value: unknown) {
  const allowed = new Set([
    "metadata",
    "source",
    "rendered",
    "versions",
    "comments",
    "publication",
  ]);
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : ["source"];
  const include = new Set(
    values
      .map((item) => String(item).trim())
      .filter((item) => allowed.has(item)),
  );
  include.add("metadata");
  return include;
}

function requiredWorkspaceId(value: unknown) {
  const workspaceId = asString(value).trim();
  if (!workspaceId) {
    throw new AppError("WORKSPACE_REQUIRED", "workspace_id is required.", 400, {
      parameter: "workspace_id",
      hint: "Pass the explicit workspace_id with every MCP tool call.",
    });
  }
  return workspaceId;
}

function assertMcpWorkspaceMatches(
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

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
