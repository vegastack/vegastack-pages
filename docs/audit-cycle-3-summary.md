# Audit Cycle 3 Summary

Branch audited: `feat/instant-workspace-v1`  
Working tree state: feature work is uncommitted; `git log main..HEAD` and `git diff --stat main...HEAD` are empty, while `git diff --stat main` shows 39 tracked files changed plus many untracked files.

## Finding Totals

| Severity  |  Count |
| --------- | -----: |
| BLOCKER   |      0 |
| HIGH      |      4 |
| MEDIUM    |     12 |
| LOW       |      8 |
| NIT       |      2 |
| **Total** | **26** |

## Recommendation

**Hold.** Do not ship this branch as-is.

The current runtime surface is mostly preserved and `pnpm test` passes 333/333, but the audit found several correctness and release-hygiene issues that should be fixed before a production release. The most important are:

- **F-001: Mutation envelopes return the pre-mutation `tree_version`.** The new client invalidation contract is likely wrong for create/move/rename/source-title changes because routes compute the navigation version before applying the mutation.
- **F-002: Shell activation would inject raw HTML page source into the parent document.** The self-audit says HTML pages fall back to full navigation, but the actual shell code does not implement that guard.
- **F-004: Public folder publications do not receive the new cache headers.** `/f/[slugId].astro` computes publication state but never sets `Cache-Control`, `ETag`, or `Vary`, so the "public publication caching complete" claim is page-only.
- **F-006: The folder partial endpoint drops `request`, breaking bearer/MCP access.** Page partials pass `request` into `resolvePageAccess`; folder partials do not, so `Authorization: Bearer ...` is ignored there.
- **F-008: The service layer has no authorization boundary.** Current HTTP routes mostly wrap it correctly, but the package is presented as ready for MCP/CLI reuse. Direct service use would allow cross-tenant or unauthorized mutations unless every caller reimplements route-level checks.
- **F-022: Build is not clean.** The web build succeeds, but emits repeated Astro prerender warnings, refuting the "build clean" claim.
- **F-026: The working tree includes 367 untracked skill/reference files plus a changed `skills-lock.json`.** This is outside the implementation report and is a release-hygiene risk.

## Section Results

Security: Findings in shell HTML handling, service authorization, cache headers, and cache semantics. No committed `ASTRO_KEY` or `VPG_INTERNAL_KEY` was found; `.dev.vars` is present and ignored by `.gitignore`.

Reliability: Findings in shell fallback behavior, stale history payloads, pre-mutation envelope versions, no-op `waitUntil`, and backend stub dispatch.

Completeness: Findings in MCP still using legacy services, folder partial bearer handling, payload/SSR drift, partial endpoint documentation drift, and public folder caching.

Performance: The mutation lock, whole-state persistence, and `buildWorkspaceNavigation` O(workspace tree) recomputation remain material costs. These are documented deferrals but still affect the branch's claimed "instant workspace" value.

Testing: The suite passes, but coverage is not aligned with the new risk: partial endpoints lack unauthorized/password/public/folder-bearer tests; service tests lack unauthorized/concurrent-conflict coverage; shell has no tests despite being shipped as future infrastructure.

Documentation: Several concrete claims are inaccurate or overstated: build "clean", `git log main..HEAD` anchoring, package source-file counts, shell tested status, SSR/payload canonicality, and public publication caching scope.
