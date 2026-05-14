# Changesets

This directory drives versioning + CHANGELOG generation for the vegastack-pages
monorepo.

## How to add a changeset

```bash
pnpm changeset
```

Pick the public package (`@vegastack/pages`) and write a short description of
the user-facing change. The internal workspace packages are private
implementation details; the public npm artifact is the CLI package only.

## How a release happens

1. Merge changesets to `develop` (prereleases) or `main` (stable).
2. The `Release (Changesets)` workflow opens a "Version Packages" PR that runs
   `pnpm run version-sync` — this calls `changeset version` for
   `@vegastack/pages` and then `scripts/sync-version.mjs`, which mirrors the
   CLI version into the root `package.json` and `Cargo.toml`, then aggregates
   the CLI changelog entry into the root `CHANGELOG.md`.
3. Merging the version PR is what produces the tag-ready commit.
4. The maintainer pushes the matching `vX.Y.Z[-next.N]` git tag — only after
   explicit approval per the release gate documented in `CLAUDE.md` and
   `AGENTS.md`.
5. The `Release` workflow takes over on tag push: builds the Rust CLI for every
   target, publishes per-platform npm sub-packages + the main
   `@vegastack/pages` umbrella, creates the GitHub release with the CHANGELOG
   slice as the body, and (on stable tags only) deploys the Cloudflare Worker.

## Prerelease mode (develop)

To open a prerelease window on `develop`:

```bash
pnpm changeset pre enter next
```

This writes `.changeset/pre.json`. All subsequent `changeset version` runs
produce `X.Y.Z-next.N` versions and publish under npm dist-tag `next`. To exit:

```bash
pnpm changeset pre exit
git add .changeset/pre.json
git commit -m "chore: exit prerelease mode"
```
