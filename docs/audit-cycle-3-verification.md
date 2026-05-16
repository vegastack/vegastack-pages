# Audit Cycle 3 Verification

This file verifies concrete claims from `docs/implementation-report-007.md` against the current working tree. Commands were run from `/Users/kmanojkumar/code/vegastack-pages` on branch `feat/instant-workspace-v1`.

## Required Anchor Commands

### Branch log

**Claim / prompt:** Run `git log --oneline main..HEAD`.  
**Status:** VERIFIED command, but it produced no commits.

```text
$ git log --oneline main..HEAD
<no output>
```

Interpretation: the feature work is currently uncommitted in the working tree, not committed on top of `main`.

### Diff stat

**Claim / prompt:** Run `git diff --stat main...HEAD`.  
**Status:** VERIFIED command, but it produced no output because `HEAD` has no committed diff from `main`.

```text
$ git diff --stat main...HEAD
<no output>
```

Useful actual working-tree diff:

```text
$ git diff --stat main
39 files changed, 1201 insertions(+), 238 deletions(-)
```

This excludes untracked files such as `packages/services/`, `apps/web/src/lib/document-payload.ts`, and `.agents/skills/*`.

### Typecheck

**Claim:** `pnpm typecheck` -> 0 errors, 0 warnings across all workspace packages.  
**Status:** VERIFIED with nuance.

```text
$ pnpm typecheck
...
apps/web typecheck: Result (279 files):
apps/web typecheck: - 0 errors
apps/web typecheck: - 0 warnings
apps/web typecheck: - 7 hints
```

Raw output includes hint lines printed with warning styling, including unused `_CommentAnchorRecord`, unused login/signup redirect imports, and deprecated iframe `scrolling`.

### Tests

**Claim:** `pnpm test` -> 333/333 passing.  
**Status:** VERIFIED.

```text
$ pnpm test
Test Files  53 passed (53)
Tests       333 passed (333)
Duration    13.68s
```

### Web build

**Claim:** `pnpm --filter @vegastack/pages-web build` -> clean.  
**Status:** REFUTED as written. Build exits 0, but emits warnings.

```text
$ pnpm --filter @vegastack/pages-web build
...
13:57:52 [WARN] `Astro.request.headers` was used when rendering the route `src/pages/docs/index.astro'`.
13:57:52 [WARN] `Astro.request.headers` was used when rendering the route `src/pages/docs/[...slug].astro'`.
...
13:57:52 [build] Complete!
```

## Implementation Report Claims

### Feature branch off `main`

**Status:** PARTIALLY VERIFIED. Current branch is `feat/instant-workspace-v1`, but the feature work is uncommitted.

```text
$ git rev-parse --abbrev-ref HEAD
feat/instant-workspace-v1

$ git log --oneline main..HEAD
<no output>
```

### `.dev.vars` is gitignored and holds local secrets

**Status:** VERIFIED for ignore/presence, not contents.

```text
$ git check-ignore -v .dev.vars
.gitignore:8:.dev.vars .dev.vars

$ test -f .dev.vars && echo present || echo absent
present

$ git ls-files .dev.vars
<no output>
```

Secret grep did not find committed `ASTRO_KEY` or `VPG_INTERNAL_KEY` values outside docs/examples.

### Runtime detection helper exists

**Status:** VERIFIED.

```text
apps/web/src/lib/runtime/target.ts:19 export function detectTarget(...)
```

Risk noted in F-013: detection uses `env.DB.withSession` as the Cloudflare discriminator.

### `api-client.ts` service-binding-or-in-process dispatcher exists

**Status:** VERIFIED, with caveat.

```text
apps/web/src/lib/api-client.ts:48 if (target === "cloudflare-edge") return env.API!.fetch(req);
apps/web/src/lib/api-client.ts:57 const backend = await getNodeBackend();
```

Caveat: the in-process backend currently returns 503 (F-012).

### Backend Worker entry stub returns `503 BACKEND_NOT_DEPLOYED`

**Status:** VERIFIED.

```text
apps/web/src/backend/index.ts:40 status: 503
apps/web/src/backend/index.ts:43 "x-vpg-backend-stub": "true"
```

### Split Worker templates exist

**Status:** VERIFIED.

```text
install/cloudflare/wrangler.frontend.example.jsonc
install/cloudflare/wrangler.backend.example.jsonc
```

### `@vegastack/pages-services` package exists

**Status:** VERIFIED.

```text
packages/services/package.json
packages/services/src/index.ts
```

### Package contains 16 source files plus tests

**Status:** REFUTED by file count.

```text
$ find packages/services/src -maxdepth 2 -type f | wc -l
20
```

There are 19 non-test source files plus `src/__tests__/envelope.test.ts`, not 16 source files.

### Seven repo interfaces and seven services exist

**Status:** VERIFIED.
Repo interfaces:

```text
attachment.repo.ts
comment.repo.ts
favorite.repo.ts
page.repo.ts
publication.repo.ts
template.repo.ts
workspace.repo.ts
```

Services:

```text
attachments.service.ts
comments.service.ts
favorites.service.ts
pages.service.ts
publications.service.ts
templates.service.ts
workspaces.service.ts
```

### Envelope helper tests: 9 Vitest cases

**Status:** VERIFIED by test file shape and full test pass.

```text
packages/services/src/__tests__/envelope.test.ts
pnpm test -> 333 passed
```

### In-memory repo adapters for all seven repos

**Status:** VERIFIED.

```text
apps/web/src/lib/runtime/repos/attachment.in-memory.ts
apps/web/src/lib/runtime/repos/comment.in-memory.ts
apps/web/src/lib/runtime/repos/favorite.in-memory.ts
apps/web/src/lib/runtime/repos/page.in-memory.ts
apps/web/src/lib/runtime/repos/publication.in-memory.ts
apps/web/src/lib/runtime/repos/template.in-memory.ts
apps/web/src/lib/runtime/repos/workspace.in-memory.ts
```

### `buildServiceContext()` factory exists

**Status:** VERIFIED.

```text
apps/web/src/lib/service-context.ts:34 export async function buildServiceContext(...)
```

Caveat: `waitUntil` and `log` are no-ops (F-011).

### 27 nav-affecting routes return mutation envelopes

**Status:** PARTIALLY VERIFIED. Grep finds envelope wiring across the listed route groups, but F-001 shows the returned `tree_version` is usually computed before the mutation.

```text
$ rg -n "buildEnvelope|jsonWithEnvelope|attachEnvelope|envelope" apps/web/src/pages/api -g '*.ts'
apps/web/src/pages/api/pages/[pageId]/patch.ts:168 envelope: result.envelope
apps/web/src/pages/api/pages/[pageId]/access.ts:61 return jsonWithEnvelope(...)
apps/web/src/pages/api/pages/[pageId]/attachments.ts:109 return jsonWithEnvelope(...)
apps/web/src/pages/api/pages/[pageId]/publication.ts:57 return attachEnvelope(...)
apps/web/src/pages/api/templates/[templateId]/pages.ts:99 return jsonWithEnvelope(...)
apps/web/src/pages/api/templates/[templateId].ts:162 return jsonWithEnvelope(...)
apps/web/src/pages/api/publications/[publicationId]/index.ts:106 return jsonWithEnvelope(...)
apps/web/src/pages/api/comment-threads/[threadId]/replies.ts:103 envelope: result.envelope
apps/web/src/pages/api/workspaces/[workspaceId]/members/[memberId].ts:191 return jsonWithEnvelope(...)
...
```

### Auth/setup/search/validate-source/mcp/sessions/me/workspaces index POST excluded

**Status:** VERIFIED for no envelope wiring in those excluded routes. This is consistent with the implementation report.

### 16 routes migrated to services + repos

**Status:** VERIFIED count by `buildServiceContext`/`services.*` usage, with caveats.

```text
$ rg -n "buildServiceContext|services\\." apps/web/src/pages/api packages/services apps/web/src/lib/service-context.ts
```

The listed 16 migrated routes are present. Caveats: `pages/[pageId]/favorite.ts` builds a local context manually instead of using `buildServiceContext`; services rely on route-level authorization rather than enforcing permissions internally (F-008).

### Document payload contract + partial endpoints exist

**Status:** VERIFIED.

```text
apps/web/src/lib/document-payload.ts
apps/web/src/pages/api/workspaces/[workspaceId]/documents/page/[ref].ts
apps/web/src/pages/api/workspaces/[workspaceId]/documents/folder/[ref].ts
```

Caveats: folder partial drops `request` (F-006), builders ignore `workspaceId` (F-007), folder payload drifts from SSR (F-017).

### Folder permissions derive from `resolveFolderActorPermission`

**Status:** VERIFIED.

```text
apps/web/src/lib/document-payload.ts:385 const permission = resolveFolderActorPermission({ actor, folder });
```

### Folder breadcrumb filtered by visibility

**Status:** VERIFIED.

```text
apps/web/src/lib/document-payload.ts:397 const visibleFolders = listVisibleFoldersForActor(actor, workspace.id);
apps/web/src/lib/document-payload.ts:399-401 ancestors.filter(...)
```

### Shell controller exists and is not activated

**Status:** VERIFIED.

```text
apps/web/src/scripts/shell/index.ts
apps/web/src/scripts/shell/types.ts

$ rg -n "bootShell" apps/web/src
apps/web/src/scripts/shell/index.ts:50 export function bootShell(...)
```

No route calls `bootShell()`.

### Shell full-page fallback for HTML pages

**Status:** REFUTED.
`document-payload.ts` emits raw HTML source for HTML pages, and `shell/index.ts` calls `swapDocument(payload)` without an HTML-source guard (F-002).

### ClientRouter restored in AppLayout

**Status:** VERIFIED.

```text
apps/web/src/layouts/AppLayout.astro:3 import { ClientRouter } from "astro:transitions";
apps/web/src/layouts/AppLayout.astro:80 <ClientRouter fallback="swap" />
```

### Public publication caching complete

**Status:** PARTIALLY VERIFIED / PARTIALLY REFUTED.
Verified for `/p/[slugId].astro`:

```text
Cache-Control: private, max-age=60
Cache-Control: public, max-age=300, s-maxage=31536000, stale-while-revalidate=60
ETag: W/"..."
```

Refuted for folder publications:

```text
$ rg -n "Cache-Control|ETag|cache-control" apps/web/src/pages/f/[slugId].astro
<no matches>
```

Also, page 304 responses return only `ETag` (F-003).

### Lazy hydration changes

**Status:** VERIFIED.

```text
apps/web/src/pages/p/[slugId].astro:1217 <CommentsRail client:idle ... />
apps/web/src/pages/p/[slugId].astro:1232 <CommandPalette client:idle ... />
apps/web/src/pages/f/[slugId].astro:375 <CommandPalette client:idle ... />
```

### CSS migration to WorkspaceLayout deferred

**Status:** VERIFIED documented deferral. `docs.css` and `comments.css` are still route imports in `p/[slugId].astro`; `docs.css` remains in `f/[slugId].astro`.

### `#vpg-document` wrapper added to page and folder routes

**Status:** VERIFIED.

```text
apps/web/src/pages/p/[slugId].astro:1165 <div id="vpg-document" ...>
apps/web/src/pages/f/[slugId].astro:358 <div id="vpg-document" ...>
```

### `.vpg-shell-article > .metadata-list` selectors loosened

**Status:** VERIFIED.

```text
$ rg -n "\\.vpg-shell-article[^,{]*>|\\.html-article[^,{]*>|\\.prose-article[^,{]*>|>\\s*\\.metadata-list" apps/web/src/styles apps/web/src/pages apps/web/src/components apps/web/src/scripts
# no direct-child selector matches; only descendant metadata-list rules remain
```

### Workspace init scripts consolidated into AppLayout

**Status:** VERIFIED.

```text
apps/web/src/layouts/AppLayout.astro:234-271 imports and runs initPageEditorController, enhanceProse, initTocRail, initHtmlPreviewResize
```

Caveat: this makes these entry modules part of every AppLayout page.

### Self-host parity 50%

**Status:** PARTIALLY VERIFIED.
Verified: adapter selector exists in `apps/web/astro.config.mjs`; runtime detection and `apiCall()` exist.  
Refuted/caveat: in-process backend is a 503 stub (F-012), and detection depends on `DB.withSession` (F-013).

### Tests +44

**Status:** VERIFIED by new test files and total pass count.

```text
packages/services/src/__tests__/envelope.test.ts
apps/web/src/lib/__tests__/document-payload.test.ts
apps/web/src/lib/__tests__/favorites-service.test.ts
apps/web/src/lib/__tests__/pages-service.test.ts
apps/web/src/lib/__tests__/comments-service.test.ts
apps/web/src/lib/__tests__/workspaces-service.test.ts
apps/web/src/pages/api/_tests/documents-route.test.ts
pnpm test -> 333 passed
```

Caveat: coverage gaps are documented in F-019 through F-021.

### Intentional deferrals documented

**Status:** MOSTLY VERIFIED.
Documented deferrals exist for shell activation, D1 adapters, persist lock removal, Worker split, Server Islands, Playwright, D1 replicas/Sessions, CSS migration, bootstrap split update, typed changed resources, and `serviceErrorToResponse` retrofit.

Questionable/overstated deferrals:

- Shell code is shipped and untested, while AppLayout says "built and tested" (F-019).
- Worker split/self-host `apiCall` has a callable 503 stub, not just inert docs (F-012).
- Public publication caching is documented as complete but excludes folder publication views (F-004).

### Files added / modified summary

**Status:** PARTIALLY VERIFIED.
The listed product files exist. However, the current working tree also contains unreported `skills-lock.json` changes and 367 untracked files under `.agents/skills` and `skills` (F-026).

## Explicit No-Finding Sections

CSRF: No new route-level CSRF bypass was found. Middleware protects browser session mutations globally; bearer-token requests without a `vpg_session` cookie are intentionally exempt from browser CSRF token requirements.

Secrets: No committed `ASTRO_KEY` or `VPG_INTERNAL_KEY` secret value was found. `.dev.vars` is present and ignored.

ClientRouter: Restored and active in `AppLayout.astro`.

Direct-child selectors: No remaining `.vpg-shell-article > .metadata-list`, `.html-article > ...`, or `.prose-article > ...` selector was found in the scanned app styles/components/scripts.
