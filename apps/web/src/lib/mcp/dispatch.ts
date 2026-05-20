import type { McpToolName } from "@vegastack/pages-mcp";
import { uploadAttachment } from "./tools/attachment";
import { createComment, deleteThread, updateThread } from "./tools/comment";
import { fetchResource } from "./tools/fetch";
import {
  createPage,
  deletePage,
  listTrash,
  movePage,
  restorePage,
  restorePageVersion,
  updatePage,
} from "./tools/page";
import { applyPublication, deletePublication } from "./tools/publication";
import { waitForReview } from "./tools/review";
import { searchWorkspace } from "./tools/search";
import {
  createTemplate,
  renderTemplate,
  updateTemplate,
} from "./tools/template";
import { inviteWorkspaceMember, validatePageSource } from "./tools/workspace";
import { whoami } from "./tools/whoami";
import type { McpToolContext } from "./types";

type ToolHandler = (
  args: Record<string, unknown>,
  context: McpToolContext,
) => Promise<unknown>;

export const toolHandlers: Record<McpToolName, ToolHandler> = {
  fetch: fetchResource,
  search: searchWorkspace,
  wait_for_review: waitForReview,
  whoami,
  create_page: createPage,
  update_page: updatePage,
  restore_page_version: restorePageVersion,
  move_page: movePage,
  delete_page: deletePage,
  restore_page: restorePage,
  list_trash: listTrash,
  create_comment: createComment,
  update_thread: updateThread,
  delete_thread: deleteThread,
  apply_publication: applyPublication,
  delete_publication: deletePublication,
  create_template: createTemplate,
  update_template: updateTemplate,
  render_template: renderTemplate,
  upload_attachment: uploadAttachment,
  invite_workspace_member: inviteWorkspaceMember,
  validate_page_source: validatePageSource,
};

export async function callTool(
  name: McpToolName,
  args: Record<string, unknown>,
  context: McpToolContext,
) {
  const ctx = context.ctx;
  if (typeof args.workspace_id === "string" && args.workspace_id) {
    ctx.actor = { ...ctx.actor, workspaceId: args.workspace_id };
  }
  const handler = toolHandlers[name];
  return handler(args, context);
}
