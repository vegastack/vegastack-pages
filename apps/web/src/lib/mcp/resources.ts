import { AppError } from "@vegastack/pages-core";
import { folders, pages, workspaces } from "@vegastack/pages-services";
import skillCli from "../../../../../skills/vegastack-pages/references/cli.md?raw";
import skillComments from "../../../../../skills/vegastack-pages/references/comments.md?raw";
import skillMcp from "../../../../../skills/vegastack-pages/references/mcp.md?raw";
import skillSecurity from "../../../../../skills/vegastack-pages/references/security.md?raw";
import skillTemplates from "../../../../../skills/vegastack-pages/references/templates.md?raw";
import skillWorkflows from "../../../../../skills/vegastack-pages/references/workflows.md?raw";
import skillReadme from "../../../../../skills/vegastack-pages/SKILL.md?raw";
import {
  assertWorkspacePermission,
  canReadPage,
  canUseWorkspace,
  getExistingPage,
} from "./permissions";
import type { McpToolContext } from "./types";

export const skillResources = [
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

export async function listResources(context: McpToolContext) {
  const ctx = context.ctx;
  const user = context.actor.user;
  const readableWorkspaces: Array<{ id: string; name: string }> = [];
  if (user) {
    const workspaceList = await workspaces.listForUser(ctx, {
      userId: user.id,
    });
    for (const workspace of workspaceList) {
      if (await canUseWorkspace(context, workspace.id, "read")) {
        readableWorkspaces.push({ id: workspace.id, name: workspace.name });
      }
    }
  }
  const allPages = await pages.list(ctx);
  const pageEntries: Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }> = [];
  for (const page of allPages) {
    if (await canReadPage(context, page)) {
      pageEntries.push({
        uri: `vpg://pages/${page.id}`,
        name: page.title,
        description: `${page.sourceType.toUpperCase()} source for ${page.folderPath ? `${page.folderPath}/` : ""}${page.title}`,
        mimeType: page.sourceType === "html" ? "text/html" : "text/markdown",
      });
    }
  }
  return [
    ...skillResources.map(([uri, name]) => ({
      uri,
      name,
      description:
        "Portable VegaStack Pages agent skill material for MCP and CLI workflows",
      mimeType: "text/markdown",
    })),
    ...pageEntries,
    ...readableWorkspaces.map((workspace) => ({
      uri: `vpg://workspaces/${workspace.id}/tree`,
      name: `${workspace.name} tree`,
      description: "Workspace folder and page tree",
      mimeType: "application/json",
    })),
  ];
}

export async function readResource(uri: string, context: McpToolContext) {
  const ctx = context.ctx;
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
    const page = await getExistingPage(context, pageMatch[1]!, "read");
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
    await assertWorkspacePermission(context, workspaceId, "read");
    const workspacePages = await pages.list(ctx, workspaceId);
    const visiblePages: Array<{
      id: string;
      folderPath: string;
      title: string;
      slugId: string;
    }> = [];
    for (const page of workspacePages) {
      if (await canReadPage(context, page)) {
        visiblePages.push({
          id: page.id,
          folderPath: page.folderPath,
          title: page.title,
          slugId: page.slugId,
        });
      }
    }
    const allFolders = await folders.listAll(ctx, { workspaceId });
    const tree = {
      workspace_id: workspaceId,
      folders: allFolders.map((folder) => ({
        id: folder.id,
        path: folder.path,
        parentId: folder.parentFolderId,
      })),
      pages: visiblePages,
    };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(tree, null, 2),
        },
      ],
    };
  }
  throw new AppError("PAGE_NOT_FOUND", "MCP resource was not found.", 404);
}
