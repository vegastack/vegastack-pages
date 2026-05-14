# Codex rules for vegastack-pages

You are working inside the vegastack-pages monorepo. Codex reads this file on
every session. Internalize the release gate **before** doing anything that
could mutate remote state.

## Release gate (hard)

Do **not**, in any session, do any of the following without the maintainer's
explicit, named release approval **in this session**:

- `git push` (any branch, any remote)
- `git tag` followed by a push that publishes the tag
- `npm publish` / `pnpm publish` (any package, any tag)
- `npm dist-tag add|rm` (move `latest` or `next`)
- `wrangler deploy` (the Cloudflare Worker that serves pages.vegastack.com)
- `gh workflow run release.yml` or any other release-workflow dispatch
- `gh release create|edit|delete`
- Editing GitHub repo settings, secrets, environments, or branch protections

Implementation approval is **not** release approval. "Go ahead", "proceed",
"looks good", "continue", "fix it", "ship-ready" — none of these authorize
remote mutation. They only authorize local edits and verification unless they
come after a ship draft/impact block and clearly answer that block.

After Codex shows the relevant draft and impact summary, short approval gates
are enough. Examples that count:

- "commit"
- "push"
- "commit and push"
- "ship"
- "release it"
- "tag and publish"
- "deploy it"
- "move npm latest to 0.1.0"

If the request is ambiguous, stop and ask.

## What you can do freely (no approval needed)

- Read and edit files under the working tree.
- Run `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm format`.
- Run `pnpm changeset` (writes a local file in `.changeset/`; no remote
  effect).
- Run `pnpm run version-sync` locally to preview a version bump (edits local
  files only).
- Build the Rust CLI for the current platform: `cd cli/vegastack-pages && node scripts/build-native.mjs`.
- Run `gh` read-only commands (`gh pr list`, `gh run view`, etc.).
- Create branches and commits locally.

## Local app startup for agents

Use the local Node backend for normal development and browser checks. It uses
SQLite and filesystem object storage under `.vegastack-pages/local`, so it is
fast and does not touch Cloudflare production data.

Terminal 1:

```sh
pnpm dev -- --port 4322
```

Terminal 2:

```sh
pnpm local:setup -- --url http://127.0.0.1:4322
```

Open `http://127.0.0.1:4322/api/auth/dev-login`. Magic links are optional in
local development and only work for users that already exist in the local
database.

If the user is using a tunnel or preview domain, do not assume a VegaStack
subdomain. Use the URL they provide. If no public URL is provided, ask whether
they are using Cloudflare Tunnel/ngrok/etc.; otherwise keep the localhost
defaults and do not set `VPG_BASE_URL`.

```sh
export VPG_PUBLIC_URL=https://<your-tunnel-url>
VPG_BASE_URL="$VPG_PUBLIC_URL" pnpm dev -- --host 0.0.0.0 --port 4322
pnpm local:setup -- --url http://127.0.0.1:4322 --public-url "$VPG_PUBLIC_URL"
```

Open `$VPG_PUBLIC_URL/api/auth/dev-login` when testing through the tunnel. Use
the printed public magic link only when specifically testing email flow. Verify
the backend is safe before writing data:

```sh
curl http://127.0.0.1:4322/api/local/status
```

Expected: `runtime=node`, `adapter=node`, `prod_data_dev=false`.

Do not run `pnpm dev:prod-data` unless the maintainer explicitly asks to debug
production Cloudflare data.

## Branch model

- `main` — production. Stable semver only (`X.Y.Z`). Releases publish to npm
  `latest` and deploy the Cloudflare Worker.
- `develop` — prerelease. Prerelease semver only (`X.Y.Z-next.N`). Releases
  publish to npm `next`. The Worker is **not** redeployed on prereleases.
- Feature branches off `develop`. Never tag a feature branch.

## Release workflow

The authoritative release procedure lives in `.agents/skills/ship/SKILL.md`.
When the maintainer asks to ship, cut a release, publish, or deploy, follow
that skill. If a step here and in the skill ever disagree, the skill wins —
update AGENTS.md in the same change.

## Repo layout

```
apps/web              Astro + Cloudflare Worker (deploys to pages.vegastack.com)
cli/vegastack-pages   Rust CLI (vpg / vegastack-pages), shipped via npm
packages/{config,core,db,mcp,renderer,ui}   Internal workspace libraries
.changeset/           Changesets — versioning + per-package CHANGELOGs
scripts/sync-version.mjs   Mirrors the canonical version into root + Cargo.toml
.github/workflows/    release-changesets.yml (Version PR), release.yml (tag → deploy + publish)
.agents/skills/ship/  Release workflow skill (this is what /ship invokes)
```

## Versioning

Single monorepo version. The `fixed` group in `.changeset/config.json` keeps
every workspace package on the same version as `@vegastack/pages`. A
changeset tagged against `@vegastack/pages` is enough to bump the whole tree.

## Cloudflare Worker deploy

Stable tags on `main` redeploy `apps/web` to `pages.vegastack.com`. The
deploy uses `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from the
`cloudflare-prod` GH environment. Do not run `wrangler deploy` locally
unless explicitly authorized — it would push past the gate.
