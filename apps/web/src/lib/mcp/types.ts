import type { ServiceContext } from "@vegastack/pages-services";
import type { UserRecord } from "@vegastack/pages-core";

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

export type McpActor = {
  user: UserRecord | null;
  userId?: string | null;
  authMode: "session" | "static_token" | "anonymous";
  workspaceId: string | null;
};

export type McpToolContext = {
  requestUrl: string;
  actor: McpActor;
  ctx: ServiceContext;
};
