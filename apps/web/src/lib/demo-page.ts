export const demoPageSource = `---
title: Get Started
type: guide
updated: 2026-05-10
---

# Get Started

VegaStack Pages turns agent-authored Markdown into a reviewable page with source editing and inline comments.

## Agent workflow

1. An agent creates a page using \`vpg pages create\` or MCP \`create_page\`.
2. A reviewer opens the shared page.
3. The reviewer selects text and adds comments.
4. The agent receives selected text and context.

## Code block

\`\`\`ts title="agent-review.ts"
export const waitUntil = "first_response";
\`\`\`

## Mermaid

\`\`\`mermaid
sequenceDiagram
  Agent->>VegaStack Pages: create_page
  User->>VegaStack Pages: comment
  VegaStack Pages->>Agent: review event
\`\`\`
`;

export const agentReviewWorkflowSource = `---
title: Agent Review Workflow
type: guide
updated: 2026-05-10
---

# Agent Review Workflow

Agents create pages, ask for review, and wait for reviewer feedback without losing the selected text context.

## Create a review page

Use the CLI or MCP tool to publish Markdown, MDX, or HTML into a workspace page.

\`\`\`bash
vpg pages create --title "API Plan" --file docs/plans/api.md
\`\`\`

## Wait conditions

Agents can wait for the first comment, any new comment, all threads resolved, or a timeout.

## Comment loop

Reviewers select text in rendered mode and add concise comments. Agents receive the selected text, thread id, page id, and reply metadata.
`;

export const mcpSetupSource = `---
title: MCP Setup
type: guide
updated: 2026-05-10
---

# MCP Setup

VegaStack Pages exposes MCP at \`/mcp\` so agents can create pages, read page resources, wait for review events, and reply to threads.

## Endpoint

\`\`\`text
https://your-domain.example/mcp
\`\`\`

## Useful tools

- \`fetch\` — mega-read; routes by \`resource_id\` prefix (\`pg_/fld_/tpl_/thr_/pub_/wks_/me\`) and accepts \`include[]\` for sub-data (\`source\`, \`edit_tokens\`, \`comments\`, \`versions\`, \`publication\`, \`members\`, ...)
- \`create_page\` / \`update_page\` (three modes: source / find-replace / checkpoint) / \`move_page\` / \`restore_page_version\`
- \`create_comment\` / \`update_thread\` (reply, resolve, reopen, anchor, complete in one call) / \`delete_thread\`
- \`apply_publication\` / \`delete_publication\` (page + folder)
- \`search\`, \`wait_for_review\`, \`validate_page_source\`, \`whoami\`

## Local development

Run the web app and point the client at the local MCP endpoint.

\`\`\`bash
pnpm dev -- --host 127.0.0.1 --port 4322
\`\`\`

For tunneled or public testing, set \`VPG_MCP_TOKEN\` and configure clients to send \`Authorization: Bearer <token>\`.

Safe edit cycle: \`fetch\` the page with \`include: ["source", "edit_tokens"]\`, then \`update_page\` with the returned \`base_version_id\` (and \`base_content_hash\` for stricter optimistic locking). On a 409 conflict, refetch and reapply.
`;
