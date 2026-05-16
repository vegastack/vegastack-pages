# Audit Cycle 3 Findings

## Security

### F-001: Mutation envelopes return the pre-mutation `tree_version`

**Severity:** HIGH  
**Category:** Reliability  
**File(s):** `apps/web/src/pages/api/workspaces/[workspaceId]/pages.ts:52-70`, `apps/web/src/pages/api/workspaces/[workspaceId]/folders.ts:37-53`, `apps/web/src/pages/api/pages/[pageId]/source.ts:131-149`, `packages/services/src/envelope.ts:36-43`  
**Evidence:**

```ts
// apps/web/src/pages/api/workspaces/[workspaceId]/pages.ts
const treeVersion = buildWorkspaceNavigation(actor, workspaceId).treeVersion;
const result = await pagesService.create(ctx, { ...treeVersion });
```

The same pre-mutation pattern appears in folder creation and source updates. `buildEnvelope()` simply copies the input `treeVersion`.  
**Impact:** Clients comparing `envelope.tree_version` to their cached sidebar tree will receive the old tree version after a nav-affecting mutation. Create/move/delete/rename and source updates that change frontmatter title can report stale navigation state, making the new invalidation contract unreliable.  
**Suggested fix:** Compute `tree_version` after the mutation, or have service/repo methods compute the post-write navigation version before building the envelope. Add tests that assert a create/move/title-change envelope differs from the pre-mutation tree version.

### F-002: Shell activation would inject raw HTML page source into the parent document

**Severity:** HIGH  
**Category:** Security  
**File(s):** `apps/web/src/lib/document-payload.ts:182-188`, `apps/web/src/lib/document-payload.ts:315-320`, `apps/web/src/scripts/shell/index.ts:88-97`, `apps/web/src/scripts/shell/index.ts:234-236`  
**Evidence:**

```ts
// document-payload.ts
html: pageWithSource.source,
...
swapPieces.push(displayedHtml);

// shell/index.ts
const payload = await fetchPayload(...);
swapDocument(payload);
...
if (main) main.innerHTML = payload.document_html;
```

The self-audit says HTML-source pages fall back to full navigation, but `navigate()` has no `payload.page?.source_type === "html"` guard before `swapDocument()`.  
**Impact:** If `bootShell()` is accidentally or later enabled, HTML-source documents are inserted directly into the app DOM instead of the current sandboxed iframe, creating a stored XSS path for any editable HTML page.  
**Suggested fix:** Before swapping, force full navigation for `payload.kind === "page" && payload.page?.source_type === "html"`. Also make `buildPageDocumentPayload()` return iframe-safe markup or omit `document_html` for HTML pages.

### F-003: Public publication 304 responses drop cache headers

**Severity:** MEDIUM  
**Category:** Reliability  
**File(s):** `apps/web/src/pages/p/[slugId].astro:111-133`, `apps/web/src/middleware.ts:67-97`  
**Evidence:**

```ts
Astro.response.headers.set("Cache-Control", "private, max-age=60");
Astro.response.headers.set("Vary", "Cookie");
...
return new Response(null, {
  status: 304,
  headers: { ETag: etag },
});
```

Middleware adds security headers, but it does not restore `Cache-Control` or `Vary`.  
**Impact:** Revalidation responses for public/password-gated publications can omit the cache policy that the 200 response had. Shared and browser caches may handle subsequent revalidation differently than intended, especially for password-gated `Vary: Cookie` responses.  
**Suggested fix:** Build the 304 response with the same cache headers as the 200 path (`ETag`, `Cache-Control`, and `Vary` when applicable), then let middleware add security headers.

### F-004: Public folder publications do not receive the new cache headers

**Severity:** HIGH  
**Category:** Completeness  
**File(s):** `apps/web/src/pages/f/[slugId].astro:68-88`, `apps/web/src/pages/f/[slugId].astro:279-287`, `apps/web/src/pages/p/[slugId].astro:103-138`  
**Evidence:**

```sh
rg -n "Cache-Control|ETag|cache-control" apps/web/src/pages/f/[slugId].astro
# no matches
```

`/f/[slugId].astro` computes `isPublicPublication` and `publicIndexable`, but only `/p/[slugId].astro` sets `Cache-Control`, `ETag`, and 304 handling.  
**Impact:** The implementation report says public publication caching is complete, but folder publications, including password-gated folder shares, do not get the intended CDN/browser cache contract.  
**Suggested fix:** Apply the same public/private/password cache policy to folder publication SSR, with an ETag based on the folder publication record plus a tree/content digest for the visible folder subtree.

### F-005: Non-indexed link publications still get one-year shared cache headers

**Severity:** LOW  
**Category:** Security  
**File(s):** `apps/web/src/pages/p/[slugId].astro:112-123`, `apps/web/src/pages/p/[slugId].astro:312-314`  
**Evidence:**

```ts
if (passwordGated) {
  Astro.response.headers.set("Cache-Control", "private, max-age=60");
} else {
  Astro.response.headers.set(
    "Cache-Control",
    "public, max-age=300, s-maxage=31536000, stale-while-revalidate=60",
  );
}
```

`publicIndexable` is computed later from `publication.indexingEnabled`, but cache behavior only checks password state.  
**Impact:** A non-password, non-indexed "link" publication is still shared-cacheable for a year at the edge. That may be acceptable for link-public resources, but it contradicts the report's "indexable + non-password-gated" wording and should be an explicit privacy decision.  
**Suggested fix:** Either document that all unpassworded link publications are CDN-cacheable, or gate long `s-maxage` on `indexingEnabled` and use a shorter/no-store policy for unindexed link shares.

### F-006: Folder partial endpoint drops `request`, so bearer/MCP auth is ignored

**Severity:** MEDIUM  
**Category:** Completeness  
**File(s):** `apps/web/src/pages/api/workspaces/[workspaceId]/documents/folder/[ref].ts:18-46`, `apps/web/src/pages/api/workspaces/[workspaceId]/documents/page/[ref].ts:20-54`, `apps/web/src/lib/access.ts:147-173`  
**Evidence:**

```ts
// folder endpoint
export const GET: APIRoute = async ({ cookies, params, url }) => {
  ...
  const access = await resolveFolderAccess({ cookies, url, folder, required: "read" });
}

// page endpoint includes request
export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  ...
  const access = await resolvePageAccess({ cookies, request, url, page, required: "read" });
}
```

`getApiRequestActor()` only sees bearer tokens when `request` is passed.  
**Impact:** MCP/CLI/bearer callers can fetch page partial payloads but not folder partial payloads. The bug is asymmetric and not covered by the six partial endpoint tests.  
**Suggested fix:** Include `request` in the folder endpoint handler parameters and pass it into `resolveFolderAccess()`. Add a bearer-token folder partial test.

### F-007: Page/folder partial payload builders ignore the `workspaceId` in their own contract

**Severity:** MEDIUM  
**Category:** Inconsistency  
**File(s):** `apps/web/src/lib/document-payload.ts:115-117`, `apps/web/src/lib/document-payload.ts:149-155`, `apps/web/src/lib/document-payload.ts:368-375`, `apps/web/src/lib/document-payload.ts:480-486`  
**Evidence:**

```ts
export type BuildDocumentPayloadInput =
  | { kind: "page"; ref: string; workspaceId: string }
  | { kind: "folder"; ref: string; workspaceId: string };

export async function buildPageDocumentPayload(
  ref: string,
  actor: RequestActor,
);
```

The dispatcher drops `workspaceId` and the builders do global slug/id lookup. The HTTP endpoints pre-check workspace membership, but the canonical builder does not.  
**Impact:** Future direct callers can accidentally build payloads for a resource outside the intended workspace, relying only on actor permissions and globally unique refs. This weakens the contract the type advertises.  
**Suggested fix:** Change builders to accept `workspaceId` and assert the resolved resource belongs to it. Keep the endpoint pre-check as defense in depth.

### F-008: Services are not an authorization boundary

**Severity:** HIGH  
**Category:** Security  
**File(s):** `packages/services/src/pages.service.ts:38-75`, `packages/services/src/workspaces.service.ts:72-149`, `packages/services/src/publications.service.ts:19-86`, `packages/services/src/context.ts:1-18`  
**Evidence:**

```ts
// context.ts
// actor identity (already verified by the caller)

// workspaces.service.ts
export async function updateMemberRole(...) {
  if (!ctx.actor.userId) throw ...
  const target = await ctx.repo.workspaces.getMemberById(input.memberId);
  const updated = await ctx.repo.workspaces.updateMemberRole(...);
}
```

The services generally check only that a user exists, not that they have the required workspace/page/folder role.  
**Impact:** Current migrated HTTP routes usually perform route-level checks first, but the package is documented as ready for MCP/CLI and future adapters. Any direct service consumer can mutate resources without centralized permission enforcement.  
**Suggested fix:** Move permission checks into services or create explicit "trusted route adapter" versus "public service API" layers. Services that mutate should require and verify target workspace membership/permission themselves.

## Reliability

### F-009: Shell click handler prevents default but does not fall back on thrown navigation errors

**Severity:** MEDIUM  
**Category:** Reliability  
**File(s):** `apps/web/src/scripts/shell/index.ts:88-111`, `apps/web/src/scripts/shell/index.ts:138-139`  
**Evidence:**

```ts
event.preventDefault();
void navigate(url.pathname + url.search + url.hash);
...
} catch (error) {
  return { ok: false, status: "error", error: error as Error };
}
```

Fetch `!ok` falls back, but JSON parse/swap/history exceptions just return `{ ok:false }` to a caller that ignores the result.  
**Impact:** If the shell is enabled, a malformed payload or DOM exception can leave the user on the old page after the browser navigation was cancelled.  
**Suggested fix:** In `onClick`, await or handle the returned result and call `window.location.assign()` when `status === "error"`.

### F-010: Shell `popstate` swaps cached payloads without revalidation

**Severity:** LOW  
**Category:** Reliability  
**File(s):** `apps/web/src/scripts/shell/index.ts:142-153`  
**Evidence:**

```ts
if (persisted?.vpgShell && persisted.payload) {
  swapDocument(persisted.payload);
  state.currentPayload = persisted.payload;
  document.title = persisted.payload.header.title;
  document.dispatchEvent(new CustomEvent("astro:page-load"));
  return;
}
```

**Impact:** Back/forward can show stale page content, stale permissions, or stale comments stats after a permission revoke, password rotation, or content update in another tab.  
**Suggested fix:** Store only a lightweight route key in `history.state`, then refetch/revalidate the payload on `popstate`. If offline fallback is desired, mark cached payloads stale and refresh in the background.

### F-011: `ServiceContext.waitUntil` silently drops future background work

**Severity:** LOW  
**Category:** Reliability  
**File(s):** `apps/web/src/lib/service-context.ts:60-67`, `packages/services/src/context.ts:90-95`  
**Evidence:**

```ts
waitUntil() {
  // Wired to Cloudflare runtime ctx.waitUntil in a follow-up
}
log() {
  /* structured logging wired later */
}
```

The public `ServiceContext` contract says `waitUntil` registers work and logging records failures; this adapter does neither.  
**Impact:** If a service starts using `ctx.waitUntil()` before the runtime adapter is finished, background tasks will be silently discarded.  
**Suggested fix:** Implement a Node/local fallback that runs the promise and logs rejection, or make `waitUntil` throw in the in-memory adapter until it is actually supported.

### F-012: `apiCall()` falls through to a 503 backend stub on Node/cloudflare-api

**Severity:** MEDIUM  
**Category:** Self-host parity  
**File(s):** `apps/web/src/lib/api-client.ts:41-58`, `apps/web/src/backend/index.ts:29-47`  
**Evidence:**

```ts
const backend = await getNodeBackend();
return backend.default.fetch(req, env, ctx ?? { waitUntil: () => undefined });
...
status: 503,
code: "BACKEND_NOT_DEPLOYED",
```

**Impact:** The plan says Node self-host falls back to an in-process backend handler. The implemented dynamic import resolves, but the imported handler is a diagnostic stub. There are no consumers today, so this is latent, but the parity claim is not true yet.  
**Suggested fix:** Either remove/export-gate `apiCall()` until the backend handler is real, or wire the Node path to the actual Astro request handler before any caller can use it.

### F-013: Runtime detection classifies Cloudflare by `DB.withSession`

**Severity:** LOW  
**Category:** Self-host parity  
**File(s):** `apps/web/src/lib/runtime/target.ts:19-30`  
**Evidence:**

```ts
if (env && typeof env.DB?.withSession === "function") {
  return typeof env.API?.fetch === "function"
    ? "cloudflare-edge"
    : "cloudflare-api";
}
return "node";
```

**Impact:** A Cloudflare environment without D1 Sessions support, or a local/miniflare binding that omits `withSession`, is treated as Node. If `apiCall()` gets a consumer, that misclassification can call the backend stub instead of a service binding.  
**Suggested fix:** Detect Cloudflare role from explicit env (`VPG_RUNTIME`) or binding shape plus adapter metadata, and treat Sessions API as a capability, not the runtime discriminator.

### F-014: `attachEnvelope()` has a header-only fallback that clients may not read

**Severity:** LOW  
**Category:** Inconsistency  
**File(s):** `packages/services/src/envelope.ts:46-85`  
**Evidence:**

```ts
if (!contentType.toLowerCase().includes("application/json")) {
  headers.set("x-vpg-envelope", JSON.stringify(envelope));
  return new Response(response.body, ...);
}
...
catch {
  headers.set("x-vpg-envelope", JSON.stringify(envelope));
  return new Response(null, ...);
}
```

**Impact:** The rollout promise is a top-level JSON `envelope` field. The helper can instead put the envelope in a header, creating two contracts. Future shell/CLI consumers may miss envelopes on successful non-JSON or malformed-JSON responses.  
**Suggested fix:** Limit `attachEnvelope()` to JSON responses and throw/fail tests if a nav-affecting route tries to use it on non-JSON. Alternatively document and test header consumption.

### F-015: `complete` returns the reply envelope even when it also resolves the thread

**Severity:** LOW  
**Category:** Inconsistency  
**File(s):** `apps/web/src/pages/api/comment-threads/[threadId]/complete.ts:81-103`  
**Evidence:**

```ts
if (Boolean(body.resolve)) {
  const resolveResult = await commentsService.resolve(...);
  resolved = resolveResult.data;
}
return Response.json({
  reply,
  resolved,
  thread: commentService.getThread(thread.thread.id),
  envelope: replyResult.envelope,
});
```

**Impact:** Today reply and resolve envelopes happen to use similar changed resources. If resolve semantics diverge later, the route will silently omit the resolve envelope details.  
**Suggested fix:** Merge changed resources from both envelopes when `resolve` is requested, or have a dedicated service method for "reply and complete".

## Completeness / Breaking Features

### F-016: MCP still uses the legacy runtime services, not the new services/repo layer

**Severity:** MEDIUM  
**Category:** Completeness  
**File(s):** `apps/web/src/pages/mcp.ts:24-47`, `apps/web/src/pages/mcp.ts:485-510`, `apps/web/src/pages/mcp.ts:663-686`, `apps/web/src/pages/mcp.ts:804-818`, `apps/web/src/pages/mcp.ts:1606-1635`  
**Evidence:**

```sh
rg -n "pageService|workspaceService|commentService|publicationService|buildServiceContext|services\\." apps/web/src/pages/mcp.ts
# many pageService/commentService/workspaceService hits; no buildServiceContext/services.* usage
```

**Impact:** The implementation report says the typed service surface is ready for MCP, but MCP mutations still bypass it, do not return mutation envelopes, and continue using the legacy runtime persistence path. Agent performance and contract consistency are not improved for MCP in v1.  
**Suggested fix:** Either document MCP service migration as deferred, or migrate MCP tool handlers to the service layer with explicit permission checks and envelope output where useful.

### F-017: Folder payload HTML is not equivalent to SSR folder HTML

**Severity:** MEDIUM  
**Category:** Completeness  
**File(s):** `apps/web/src/lib/document-payload.ts:423-448`, `apps/web/src/pages/f/[slugId].astro:354-368`  
**Evidence:**

```ts
// payload builder
const documentHtml = `<ul class="vpg-folder-children">` + ...

// SSR folder route
<p class="prose-eyebrow">Folder</p>
<h1 class="prose-title">{folder.name}</h1>
<FolderPageList rows={listRows} ... />
```

**Impact:** A future shell swap into a folder will not match the current SSR folder UI: no eyebrow/title, no `FolderPageList` component markup, no thread counts/child counts behavior.  
**Suggested fix:** Make the payload builder render the same component/markup as SSR, or explicitly mark folder shell swaps unsupported until parity exists.

### F-018: Page partial endpoint comments overstate public-publication support

**Severity:** LOW  
**Category:** Documentation  
**File(s):** `apps/web/src/pages/api/workspaces/[workspaceId]/documents/page/[ref].ts:8-11`, `apps/web/src/pages/api/workspaces/[workspaceId]/documents/page/[ref].ts:43-55`, `apps/web/src/lib/document-payload.ts:161-169`  
**Evidence:**

```ts
// endpoint comment
// public publications are accessible to anonymous actors.

// builder
const permission = resolveActorPermission({ actor, page });
...
if (!scope.read) return null;
```

Anonymous publication access from `resolvePageAccess()` is not passed into the builder; the builder recomputes member permission only.  
**Impact:** The code currently returns 404 for anonymous/public partial payloads, which may be intended while shell is member-only. The route comments and implementation report are inconsistent, making future activation easy to wire incorrectly.  
**Suggested fix:** Update comments/docs to say partial payloads are member-only, or change the builder to accept `PageAccess` and intentionally support public publications.

### F-019: Shell controller is shipped but untested

**Severity:** MEDIUM  
**Category:** Testing  
**File(s):** `apps/web/src/scripts/shell/index.ts:1-298`, `apps/web/src/layouts/AppLayout.astro:8-22`  
**Evidence:**

```sh
rg -n "bootShell|vpg-shell|shell controller|payloadUrlFor|swapDocument" apps/web/src -g '*test*'
# no matches
```

`AppLayout.astro` says the shell is "built and tested", but no shell test exists.  
**Impact:** The riskiest future code path (link interception, DOM swap, history, D1 bookmark replay) has no unit coverage, and this audit found multiple shell bugs by inspection.  
**Suggested fix:** Add focused unit tests for `payloadUrlFor`, click filtering, HTML-page fallback, fetch error fallback, and popstate behavior before keeping the controller in the shipped tree.

### F-020: Partial endpoint tests miss the risky access cases

**Severity:** MEDIUM  
**Category:** Testing  
**File(s):** `apps/web/src/pages/api/_tests/documents-route.test.ts:64-185`, `apps/web/src/lib/__tests__/document-payload.test.ts:56-190`  
**Evidence:**

```ts
it("returns a DocumentPayload for a member who can read the page", ...)
it("accepts the pg_* id ref as well as the slug_id", ...)
it("404s for an unknown ref", ...)
it("404s when the page exists but in a different workspace", ...)
it("returns a folder payload with workspace breadcrumb", ...)
it("404s for an unknown folder", ...)
```

No tests cover anonymous, unauthorized member, reader role affordances, bearer folder access, public publication, password-gated publication, or HTML-source pages.  
**Impact:** The exact auth and HTML-shell risks in this audit are not guarded by tests.  
**Suggested fix:** Add negative and edge tests for the partial endpoints before activating the shell or calling the endpoints from non-browser clients.

### F-021: Service tests do not exercise unauthorized actors or concurrent conflicts

**Severity:** MEDIUM  
**Category:** Testing  
**File(s):** `apps/web/src/lib/__tests__/pages-service.test.ts:65-202`, `apps/web/src/lib/__tests__/workspaces-service.test.ts:51-137`, `apps/web/src/lib/__tests__/comments-service.test.ts:82-227`  
**Evidence:** The new service tests cover happy paths and a small number of not-found cases. They do not assert unauthorized actors, cross-workspace actors, stale `baseVersionId` conflicts through services, or last-admin protections through service methods.  
**Impact:** The services are intended as a reusable application layer, but their missing authorization and conflict behavior is not visible in tests.  
**Suggested fix:** For each service module, add tests for happy path, unauthorized actor, not-found resource, cross-workspace actor, and concurrent update conflict where applicable.

### F-022: Build succeeds but is not "clean"

**Severity:** MEDIUM  
**Category:** Documentation  
**File(s):** `docs/implementation-report-007.md:7`, `apps/web/src/pages/docs/index.astro`, `apps/web/src/pages/docs/[...slug].astro`  
**Evidence:**

```text
pnpm --filter @vegastack/pages-web build
...
13:57:52 [WARN] `Astro.request.headers` was used when rendering the route `src/pages/docs/index.astro'`.
13:57:52 [WARN] `Astro.request.headers` was used when rendering the route `src/pages/docs/[...slug].astro'`.
...
13:57:52 [build] Complete!
```

The warning repeats across prerendered docs pages.  
**Impact:** The build exits 0, but "clean" is inaccurate. If warning-free builds are a release gate, this branch does not meet it.  
**Suggested fix:** Either fix the docs routes' `Astro.request.headers` usage during prerender, or update the report to say build passes with known Astro prerender warnings.

### F-023: Typecheck output includes 7 Astro hints despite "0 warnings" wording

**Severity:** NIT  
**Category:** Documentation  
**File(s):** `apps/web/src/lib/runtime/repos/comment.in-memory.ts:17-18`, `apps/web/src/pages/p/[slugId].astro:1198`  
**Evidence:**

```text
src/lib/runtime/repos/comment.in-memory.ts:18:6 - warning ts(6196): '_CommentAnchorRecord' is declared but never used.
src/pages/p/[slugId].astro:1198:23 - warning ts(6385): 'scrolling' is deprecated.
Result (279 files):
- 0 errors
- 0 warnings
- 7 hints
```

**Impact:** Astro summarizes these as hints, so the top-line claim is technically true, but the raw output is not noise-free.  
**Suggested fix:** Remove the unused type alias/import marker and deprecated iframe attribute, then report both top-line diagnostics and hints explicitly.

## Performance

### F-024: Every envelope route recomputes full workspace navigation synchronously

**Severity:** MEDIUM  
**Category:** Performance  
**File(s):** `apps/web/src/lib/workspace-navigation.ts:19-88`, `apps/web/src/lib/workspace-navigation.ts:174-198`, `apps/web/src/pages/api/pages/[pageId]/source.ts:131-134`, `apps/web/src/pages/api/workspaces/[workspaceId]/folders.ts:37-43`  
**Evidence:**

```ts
const allPages = pageService.listPages(workspaceId);
const allFolders = workspaceService.listFolders(workspaceId);
...
treeVersion: workspaceTreeVersion({ pages: visiblePages, folders: visibleFolders, ... })
```

`workspaceTreeVersion()` serializes every visible page/folder stamp and sorts them.  
**Impact:** Each nav-affecting mutation now adds an O(pages + folders) synchronous navigation pass before the existing mutation and whole-state persist. On a 10k page workspace this is a visible latency cliff.  
**Suggested fix:** Maintain a monotonic workspace navigation version or compute post-write tree hashes from indexed/versioned data. At minimum cache navigation per request and benchmark large workspaces.

### F-025: The global mutation lock and whole-runtime persistence remain on all normal mutations

**Severity:** MEDIUM  
**Category:** Performance  
**File(s):** `apps/web/src/middleware.ts:158-177`, `apps/web/src/pages/mcp.ts:253-265`, `apps/web/src/lib/runtime.ts:2347-2421`, `apps/web/src/lib/runtime.ts:2462-2605`  
**Evidence:**

```ts
const lock = await acquireRuntimeMutationLock();
...
if (response.status < 400) {
  await pruneExpiredVersions();
  await persistRuntimeState();
}
```

`persistNormalizedRuntimeStateBatch()` still reads every service map and rewrites normalized tables.  
**Impact:** The branch adds service wrappers but does not remove the largest latency source described in the plan. The audit/report acknowledge deferral, but the "instant workspace" performance benefit is not delivered on mutation paths yet.  
**Suggested fix:** Keep this as a blocking follow-up for the actual performance release, or make the current branch explicitly foundation-only and avoid shipping it as a performance improvement.

## Dead Code / Hygiene

### F-026: Untracked skill/reference files and `skills-lock.json` changes are outside the implementation report

**Severity:** MEDIUM  
**Category:** Gap  
**File(s):** `skills-lock.json:1-59`, `.agents/skills/*`, `skills/*`  
**Evidence:**

```text
git ls-files --others --exclude-standard .agents/skills skills | wc -l
367

du -sh .agents/skills skills
2.2M .agents/skills
40K skills
```

`skills-lock.json` adds eight Cloudflare-related skills from `cloudflare/skills`; these files are not described in the implementation report's file summary.  
**Impact:** A commit could accidentally vendor large agent reference material into the product repo. This also makes the branch diff misleading because `git diff --stat main` excludes untracked files.  
**Suggested fix:** Decide whether these are intentionally vendored. If not, remove them from the working tree and revert `skills-lock.json`; if yes, document why they belong in the release.
