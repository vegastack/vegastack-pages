# Managed Hosting Plan

Status: Draft implementation plan  
Date: 2026-05-10

## Intent

VegaStack Pages supports two deployment modes:

- `self_hosted`: default OSS mode. First admin is created through setup, users are invited, public signup is disabled.
- `managed`: hosted mode at `pages.vegastack.com/app`. Anyone can sign up, create a workspace, and start using the product without deploying infrastructure.

Both modes must share the same app, renderer, comments, permissions, MCP endpoint, CLI API semantics, and storage abstractions. Managed mode is a product configuration, not a separate fork.

## Hosted Domain Model

- `pages.vegastack.com`: product/docs/marketing surface.
- `pages.vegastack.com/app`: authenticated managed app.
- Page links remain globally shaped as `/p/page-title-abc123`.
- Access is resolved by page ID, workspace membership, and public publication. A user who belongs to multiple workspaces can open any accessible global page URL without workspace path prefixes.

## Signup Flow

1. User opens `https://pages.vegastack.com/app/signup`.
2. User enters display name, email, and workspace name.
3. API rate-limits by email and creates or reuses the user.
4. If the user has no workspace, the API creates one with a unique slug.
5. The workspace is seeded with starter pages and folders.
6. User receives a magic link redirecting to the first seeded page.
7. Google OAuth can be added as an optional path after the baseline magic-link flow is reliable.

Self-hosted mode returns a clear disabled state for `/app/signup` unless the admin explicitly enables public signup for testing or a controlled deployment.

## Tenant Boundary

- Workspace ID is the tenant boundary.
- Every page, folder, comment, publication, attachment, audit log, and search index row carries a workspace ID.
- Server-side permission checks are required for every read, write, search, export, attachment, comment, and MCP operation.
- Search results must be filtered by accessible workspace/page permissions before returning to the client.
- Public edit links grant access only to the linked page, not sibling pages.

## Managed Deployment Requirements

- Environment: `VPG_DEPLOYMENT_MODE=managed`.
- Public signup enabled by deployment mode.
- Email magic links required in production. Development may expose a debug verification URL.
- Workspace bootstrap must be idempotent and avoid duplicate starter pages.
- Audit log records `workspace.signup_created` and `workspace.seeded`.
- Managed hosting should use the same Cloudflare primitives as self-hosting: Workers, D1, R2, Durable Objects where needed, and optional Cloudflare Email Service.

## Product UX

- New users land directly in the first page of their workspace after magic-link verification.
- The initial workspace should include clean starter pages for getting started, agent review workflow, and MCP setup.
- Login page links to signup in managed mode.
- Theme menu supports System, Light, and Dark across login, signup, setup, and document views.

## Operational Notes

- Managed hosting must not depend on self-host setup tokens.
- Self-host update and deploy commands remain package driven through `vpg`.
- Managed app deployment is operated by VegaStack; customer self-host deployments remain independent and configurable.
- Future billing, abuse controls, Turnstile, quotas, and workspace deletion flows are separate phases.

## Acceptance Criteria

- With `VPG_DEPLOYMENT_MODE=managed`, `/` remains the public landing page and `/app` sends unauthenticated users to `/app/signup`.
- `/app/signup` creates a workspace, seeds pages, and returns or sends a magic link.
- Magic-link verification redirects to the target workspace page.
- With default self-host config, `/app/signup` does not create accounts.
- Existing workspace permissions and public publications continue to gate all page access.
- Light, dark, and system theme choices persist locally and apply before first paint.
