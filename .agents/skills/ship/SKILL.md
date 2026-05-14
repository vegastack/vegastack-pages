---
name: ship
description: "Ship workflow for @vegastack/pages. Handles the release cycle: analyze git diff, audit docs for stale references, draft version + CHANGELOG + commit + release notes, then commit, push, tag, and let GitHub Actions publish npm and deploy Cloudflare. TRIGGER: when user runs /ship or asks to ship, release, cut a release, publish, commit and push, or deploy. Only for this project (vegastack-pages)."
user-invokable: true
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Bash(cargo:*), Bash(wrangler:*)
---

# Ship Workflow — @vegastack/pages

Full release cycle for VegaStack Pages: diff analysis, docs audit, CHANGELOG,
version sync, commit, push, tag, GitHub release, npm publish, and Cloudflare
Worker deploy.

## How Releases Actually Ship Here

- **User-facing npm package**: `@vegastack/pages`.
- **Generated native packages**: `@vegastack/pages-darwin-x64`,
  `@vegastack/pages-darwin-arm64`, `@vegastack/pages-linux-x64`,
  `@vegastack/pages-linux-arm64`, and `@vegastack/pages-win32-x64`.
  Users should not install these directly; the umbrella package uses them as
  platform-specific `optionalDependencies`.
- **Source of truth for version**: the monorepo version. Root
  `package.json`, every workspace `package.json`,
  `cli/vegastack-pages/package.json`, and
  `cli/vegastack-pages/Cargo.toml` must match.
- **Version sync**: `pnpm run version-sync` runs Changesets and
  `scripts/sync-version.mjs`, updates package versions, updates generated CLI
  platform dependency pins, and aggregates package changelog entries into root
  `CHANGELOG.md`.
- **Cloudflare deploy**: stable tags from `main` deploy `apps/web` to
  `pages.vegastack.com` without waiting for npm. Prerelease tags do not deploy
  the Worker by default.
- **Release trigger**: pushing a `v*` tag triggers
  `.github/workflows/release.yml`.
- **Distribution**: `release.yml` builds all Rust CLI platform binaries,
  publishes generated platform packages first, then publishes
  `@vegastack/pages` to public npm using trusted publishing and provenance.
- **GitHub Release**: `release.yml` creates the GitHub release from the
  matching root `CHANGELOG.md` slice after npm publish succeeds and the deploy
  job is either successful or skipped for prereleases.

## Hard Release Gate

Do not commit, push branches, push tags, publish packages, move npm dist-tags,
deploy the Cloudflare Worker, create/edit GitHub releases, edit GitHub repo
settings, or dispatch release workflows until the maintainer gives the
required approval in the current conversation.

Implementation approval is not release approval. Do not treat "go ahead",
"proceed", "implement it", "fix it", "looks good", "continue", "ship-ready",
or similar wording as permission to commit or mutate remote state. Those
phrases allow local edits and verification only, unless they appear after the
ship draft/impact block and clearly answer that block.

There are two approvals:

1. **Commit approval**: required before creating or amending a local release
   commit. It must come after the relevant draft is shown. The maintainer can
   say "commit", "commit it", "create the commit", or "commit and push".
2. **Push approval**: required before any remote mutation. It must come after
   the remote impact block is shown. The maintainer can say "push", "ship",
   "release it", "deploy it", "tag and publish", or "commit and push" when
   the current ship context already names the branch, tag, npm dist-tag, and
   deploy target.

Before any remote mutation, show the release impact in plain language:

- version being released
- target branch and tag
- npm dist-tag impact
- whether the Cloudflare Worker will redeploy

Do not require the maintainer to retype exact commands. Wait for a short push
gate, for example:

- "push"
- "ship"
- "release it"
- "deploy it"
- "tag and publish"
- "commit and push"

If the request is ambiguous, stop and ask. Never infer publish approval from
prior discussion or from a successful test run.

## Step 1: Analyze The Diff

Run in parallel where possible:

- `git status --short`
- `git diff --stat`
- `git diff`
- `git diff --cached --stat`
- `git diff --cached`
- `git log --oneline -10`
- `gh release list --limit 1 --json tagName --jq '.[0].tagName'`
- `node -p "require('./package.json').version"`
- `node -p "require('./cli/vegastack-pages/package.json').version"`
- read `CHANGELOG.md` lines 1-100

If there is no prior GitHub release, treat this as a first release. If the
local version disagrees with the latest GitHub release tag, surface the
discrepancy and do not proceed silently.

For a root commit with no `HEAD`, use staged-file inspection instead of a
normal diff. Do not assume `git diff HEAD` works before the first commit.

## Step 1.5: Audit All Docs For Outdated Information

This step is critical. Do not skip or skim.

First, build a change manifest listing every feature, behavior, command, MCP
tool, API route, env var, Cloudflare binding, npm package, install step,
workflow, file path, template, docs page, or deployment behavior added,
removed, renamed, or changed in the diff.

Then audit every tracked Markdown/MDX file, excluding generated or dependency
directories. Use:

```bash
git ls-files '*.md' '*.mdx'
```

Read or grep all of them against the change manifest. Fix issues in place.

Files that must always be checked:

- `README.md`
- `cli/vegastack-pages/README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `SUPPORT.md`
- `PRODUCT.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/README.md`
- `docs/mcp-local-testing.md`
- `docs/specs/003-mcp-cli.md`
- `docs/specs/004-deployment-self-hosting.md`
- `docs/specs/008-configuration-env.md`
- `install/cloudflare/README.md`
- `install/docker/README.md`
- every file under `apps/web/src/content/docs/`
- every file under `skills/vegastack-pages/references/`

Also check user-facing source copy:

- `apps/web/src/pages/index.astro`
- `apps/web/src/pages/docs/index.astro`
- `apps/web/src/layouts/AppLayout.astro`
- `apps/web/src/layouts/DocsLayout.astro`
- settings pages under `apps/web/src/pages/app/settings/`
- CLI help/source in `cli/vegastack-pages/src/main.rs`

Cover three cases:

- **Stale references**: old command names, old MCP tools, old env vars, old
  install steps, old package names, old managed-hosting URLs, old Cloudflare
  bindings, or docs saying a feature is missing when code now supports it.
- **Missing docs**: new features not documented, especially templates, HTML
  pages, comments/review loops, version history, Backup to Git, MCP, CLI,
  managed hosting, and self-hosting.
- **Inconsistent docs**: files disagree about the npm package, MCP endpoint,
  Cloudflare setup, GitHub backup setup, or release workflow.

Report what changed. If nothing is stale, say exactly:
"Audited N markdown files plus user-facing source — no stale references found."

## Step 2: Draft Version, CHANGELOG, Commit, And Release

Analyze all changes in the diff and produce five drafts before changing
versions or releasing:

1. **Suggested version**
   - Patch (`0.y.Z`): fixes, docs-only changes, internal refactors,
     dependency bumps without behavior changes, CI tweaks.
   - Minor (`0.Y.0`): new features, new user-facing workflows, new MCP/CLI
     surface, new templates, new self-hosting/deployment surface, or breaking
     changes while still in `0.x`.
   - Major (`X.0.0`): never suggest a major unless the maintainer explicitly
     asks for `1.0` or another major.

2. **CHANGELOG entry**
   - Root `CHANGELOG.md` exists and is the release-note source for this repo.
   - Prefer Changesets for normal releases. If no changesets exist or this is
     a first manual release, write a concise root section in a Keep a
     Changelog style:

     ```markdown
     ## X.Y.Z

     One-line summary.

     ### Added
     - User-visible additions.

     ### Changed
     - Behavior or workflow changes.

     ### Fixed
     - Bugs fixed.

     ### Removed
     - Removed functionality.
     ```

   - Do not create empty section headers.
   - Mark breaking changes as **BREAKING**.
   - If using Changesets, ensure `pnpm run version-sync` generates/aggregates
     the root entry and consumes `.changeset/*.md`.

3. **Commit message**
   - Use conventional commit format.
   - For initial release commits, prefer:

     ```text
     feat: prepare initial VegaStack Pages release vX.Y

     ## What Changed
     - Human-readable bullets.

     ## Why
     Business or technical reason.

     ## Technical Details
     - path/to/file: what changed and why.

     Co-Authored-By: OpenAI Codex <noreply@openai.com>
     ```

   - Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `build`,
     `ci`, `perf`, `test`.
   - Common scopes: `web`, `cli`, `mcp`, `docs`, `ci`, `release`.
   - Use a HEREDOC when committing multiline messages.

4. **GitHub release title**
   - Format: `vX.Y.Z — Short Description`.

5. **GitHub release body**
   - One-paragraph overview.
   - `### Highlights` with three to five user-visible bullets.
   - `### Install` snippet:

     ```bash
     npm install -g @vegastack/pages@X.Y.Z
     ```

   - Link to the changelog entry:
     `Full notes: CHANGELOG.md#XYZ-anchor`.
   - Match the style of existing releases if any exist:
     `gh release view <latest> --json body --jq .body`.

Present all five drafts for release commits. For smaller release-fix commits,
present a concise commit draft and impact summary. Ask the maintainer to say
"commit" or "commit and push". Do not commit, amend, push, tag, or release
until they give the relevant short gate.

Hard stop: if the relevant draft has not been shown in the current
conversation, you must not run `git commit`, `git commit --amend`, `git tag`,
`git push`, `gh release`, `gh workflow run`, `npm publish`, `pnpm publish`, or
`wrangler deploy`.

### Version Chronology Validation

When the maintainer confirms or overrides the version:

1. Treat the latest GitHub release tag as the authoritative current version.
2. Verify the new version is strictly greater than the latest release.
3. Verify semver sequencing. Do not silently skip versions unless the
   maintainer explicitly confirms the skip.
4. If local package versions disagree with the latest GitHub release, explain
   the discrepancy before proceeding.
5. Stable releases from `main` publish to `latest`. Prereleases from `develop`
   publish to `next`.

## Step 3: Apply Version And CHANGELOG

After the maintainer confirms the version:

1. Run or update Changesets as needed.
2. Run `pnpm run version-sync`.
3. Confirm these files now report `X.Y.Z`:
   - `package.json`
   - `apps/web/package.json`
   - every `packages/*/package.json`
   - `packages/mcp/package.json`
   - `cli/vegastack-pages/package.json`
   - `cli/vegastack-pages/Cargo.toml`
4. Confirm root `CHANGELOG.md` contains the release section.
5. Confirm `.changeset/*.md` has no pending release changes except
   `.changeset/README.md`.
6. Do not hand-edit `pnpm-lock.yaml` unless a package metadata change requires
   it. If needed, run `pnpm install` and stage the lockfile.

Show the maintainer the list of files that will be committed.

## Step 4: Release Preflight

Run:

```bash
CI=true pnpm install --frozen-lockfile
pnpm format
pnpm typecheck
pnpm -r --if-present build
pnpm test
pnpm --filter @vegastack/pages test
cargo test --manifest-path cli/vegastack-pages/Cargo.toml
pnpm test:coverage
pnpm vitest run install/docs-hygiene.test.ts
```

Run release audits:

```bash
git ls-files | rg '(^|/)(node_modules|target|dist|npm-publish|coverage|\.vegastack-pages|\.wrangler|\.astro)(/|$)|\.tgz$|^VegaStack$|^\.agents/skills/impeccable/|\.env$|\.env\.[^e]'
git ls-files | rg -v '^\.agents/skills/ship/SKILL\.md$' | xargs rg -n --hidden '(npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN (OPENSSH |EC |)PRIVATE KEY|CLOUDFLARE_API_TOKEN=[^<[:space:]]|VPG_GITHUB_APP_PRIVATE_KEY=[^<[:space:]])'
```

The first audit must produce no output. The second audit must have no real
secret hits. Placeholder docs such as `<token>` are allowed.

Run npm readiness:

```bash
npm publish --dry-run --access public --tag latest
```

from `cli/vegastack-pages`, and confirm no npm auto-correction warnings.

Cross-build and smoke-test the current platform package when possible:

```bash
cd cli/vegastack-pages
node scripts/cross-build.mjs --target <rust-target> --platform <npm-platform>
(cd npm-publish/<platform> && npm publish --dry-run --access public --tag latest)
```

Then pack the umbrella and platform package into a temporary project and
confirm:

```bash
./node_modules/.bin/vpg version
```

prints `vpg X.Y.Z`.

Confirm npm package names are either unpublished for a first release or have no
conflicting version:

- `@vegastack/pages`
- `@vegastack/pages-darwin-x64`
- `@vegastack/pages-darwin-arm64`
- `@vegastack/pages-linux-x64`
- `@vegastack/pages-linux-arm64`
- `@vegastack/pages-win32-x64`

If a `/vegastack-audit` tool is available in the maintainer environment, run:

```text
/vegastack-audit scope=changed mode=ephemeral
```

Critical or High findings block release until fixed or explicitly accepted by
the maintainer. Commit the audit report if the tool writes one. If the tool is
not available, rely on the local release audit chain above.

## Step 5: Wait For Commit And Push Gates

Display:

```text
Ready to ship vX.Y.Z

Files to commit:
  - <files>

Commit message: <first line>
Tag:            vX.Y.Z
Release title:  vX.Y.Z — <title>
Release impact:
  - branch push: <branch>
  - tag push: vX.Y.Z
  - npm dist-tag: latest|next
  - Cloudflare deploy: yes|no

Say "commit" to create/amend the local release commit.
Say "commit and push" to create/amend the local commit and then push/tag so
GitHub Actions publishes and deploys according to the impact above.
```

Do not require the maintainer to type exact commands. The gates are the words
`commit`, `push`, `commit and push`, `ship`, `release it`, `tag and publish`,
or `deploy it` after the draft/impact block has been shown.

Do not push, tag, dispatch, publish, deploy, or create/edit releases until the
maintainer gives a push gate.

## Step 6: Create The Local Commit

After a `commit` or `commit and push` gate, run sequentially:

1. Stage specific files by name. Do not use `git add -A` or `git add .` after
   the initial source import is complete unless this is an explicitly reviewed
   empty-repo first import.
2. Commit with the approved message via HEREDOC. For amendments, use
   `git commit --amend -m "$(cat <<'EOF' ... EOF)"` only after showing the
   amended draft.
3. Print the commit SHA and first-line subject.
4. If the gate was only `commit`, stop and show the release impact block.
5. If the gate was `commit and push`, continue to Step 7.

## Step 7: Execute Remote Ship

After a `push`, `commit and push`, `ship`, `release it`, `tag and publish`, or
`deploy it` gate, run sequentially:

1. `git pull --rebase origin main` if the remote branch exists. For an empty
   first push, explain that there is no remote branch to rebase from.
2. `git push -u origin main` for first push, otherwise `git push origin main`.
3. `git tag vX.Y.Z`
4. `git push origin vX.Y.Z`
5. Do not manually run `npm publish` or `wrangler deploy`; `release.yml` owns
   those steps.
6. Watch the GitHub Actions release run until it succeeds, fails, or is clearly
   blocked on external runner/environment capacity.
7. Print:
   - commit URL
   - release URL, when available
   - GitHub Actions run URL:
     `gh run list --workflow=release.yml --limit 1 --json url --jq '.[0].url'`

## Step 8: Verify Release

After the branch or tag push:

- Watch the release workflow:
  `gh run list --workflow=release.yml --limit 1 --json databaseId,url,status,conclusion`
- If the run fails, run `gh run view <id> --log-failed`, write a short RCA,
  patch the underlying issue locally, then return to Step 5 with a new commit
  draft and ask for `commit` or `commit and push`.
- Confirm npm package version after publish:
  `npm view @vegastack/pages version --registry=https://registry.npmjs.org`
- Confirm the managed app after deploy:
  `https://pages.vegastack.com`
- Confirm the managed MCP endpoint:
  `https://pages.vegastack.com/mcp`

If publish or deploy fails, do not retag or force-push. Investigate the
workflow failure, report the RCA, patch forward, and ask for the next
`commit and push` gate. Common publish causes are trusted publishing setup,
missing npm package configuration, or a tag/package version mismatch.

## Step 8.5: Re-dispatch After Partial Failure

When a CI run partially fails (one job succeeded, another did not), do **not**
delete the tag, force-push, or republish over the successful jobs. The
`release.yml` workflow exposes per-side skip toggles for this scenario:

- `publish_npm: no` — skips `build-cli-matrix` + `publish-npm`. Use when npm
  already has the version under its target dist-tag.
- `deploy_worker: no` — skips the Cloudflare Worker deploy. Use when
  `pages.vegastack.com` is already serving the target tag.

`github-release` runs as long as both upstream jobs are either `success` or
`skipped`, so it will create the GitHub release on the re-dispatch even when
the original release-time job is skipped.

Detection: before suggesting a re-dispatch, check what already shipped:

```sh
# Did npm get the version?
npm view @vegastack/pages@<version> version 2>/dev/null

# Did pages.vegastack.com get the new build? Compare an asset hash from the
# tag's built output (apps/web/dist/client) against what the live site serves.
curl -sL https://pages.vegastack.com | grep -oE '/_astro/[A-Za-z0-9._-]+' | head -1

# Was there already a GitHub release?
gh release view v<version> --json tagName 2>/dev/null
```

If the bug was in the workflow itself (e.g. a YAML or inline-Node typo in
`release.yml`), patch it as a separate `fix(ci): ...` commit on `main` first.
Future dispatches use the workflow definition from `--ref main` (or the tag,
depending on the dispatch source), so the fix takes effect immediately
without retagging the release.

Re-dispatch example for "npm published, Worker failed, github-release
skipped":

```sh
gh workflow run release.yml --ref main \
  -f tag=vX.Y.Z \
  -f npm_tag=latest \
  -f deploy_worker=yes \
  -f publish_npm=no
```

Present the detection results and the dispatch plan to the maintainer.
Confirm with a short gate (`re-dispatch`, `retry deploy`, `redo worker`)
before running `gh workflow run`. Then watch the run as in Step 8.

## Rules

- Never create or amend a local release commit before showing the relevant
  draft and receiving a `commit` or `commit and push` gate.
- Never push, tag, publish, deploy, dispatch workflows, or create a GitHub
  release before showing the impact block and receiving a push gate.
- Never force-push.
- Never use `--no-verify`, `--no-gpg-sign`, or destructive git reset commands.
- Always stage by name after the first import. Avoid `git add -A` except for a
  deliberate, reviewed initial source import into an empty repo.
- Always verify versions before tagging.
- Always push the branch before pushing the tag.
- Tag format is exactly `vX.Y.Z` for stable releases and `vX.Y.Z-next.N` for
  prereleases.
- For 0.x releases, breaking changes go in a minor bump, not a major, and must
  be marked **BREAKING** in the changelog.
- If `git status` is clean and there is nothing to ship, abort with "Nothing
  to ship."
