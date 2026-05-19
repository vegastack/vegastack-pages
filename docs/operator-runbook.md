# VegaStack Pages — Operator Runbook

This is the operator-side runbook for cutting a production deploy of
the clean-slate rebuild (Plan 011 / 012). The code in `apps/web` builds
to a single Cloudflare Worker; this document spells out the **destructive
infrastructure cutover** that must precede the first deploy, plus the
ongoing operational tasks (secrets, monitoring, rate limits, email
domain verification).

> ⚠️ The destructive steps in §3 truncate the live D1 and purge R2
> prefixes. They assume the **no-production-users premise** in
> CLAUDE.md. Do not run them against a database with real workspace
> data.

## 1. One-time bootstrap (do this once per environment)

### 1.1 Cloudflare authentication

```sh
wrangler whoami
# Expect: the maintainer's account email.
```

### 1.2 Resource inventory

```sh
wrangler kv namespace list
wrangler r2 bucket list
wrangler d1 list
wrangler deployments list --name vegastack-pages
```

Save the listing to `/docs/audits/YYYY-MM-DD-live-infra-inventory.md`
so the team has a record of what was present before the cutover.

Expected post-bootstrap state:

| Resource    | Count                                          |
| ----------- | ---------------------------------------------- |
| D1 database | 1 (`vegastack-pages-db`)                       |
| R2 bucket   | 1 (`vegastack-pages-content`)                  |
| Workers     | 1 (`vegastack-pages` on `pages.vegastack.com`) |

### 1.3 Secrets

Set every secret the Worker reads at runtime. Use `wrangler secret put` —
**never** commit to `wrangler.jsonc`. The canonical list:

```sh
# Email — AWS SES primary
wrangler secret put AWS_REGION                  # e.g. us-east-1
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put AWS_SESSION_TOKEN           # only if STS-issued

# GitHub backup app
wrangler secret put VPG_GITHUB_APP_PRIVATE_KEY
wrangler secret put VPG_GITHUB_APP_CLIENT_ID
wrangler secret put VPG_GITHUB_APP_CLIENT_SECRET

# First-run admin setup
wrangler secret put VPG_SETUP_TOKEN

# Astro server-island prop encryption
wrangler secret put ASTRO_KEY
```

### 1.4 Email domain verification

#### AWS SES (primary)

1. Open the SES console → **Identities** → **Create identity**
2. Domain: `pages.vegastack.com`
3. Configure **easy DKIM** — SES gives you three CNAMEs; add them to
   Cloudflare DNS for `pages.vegastack.com`
4. Wait for SES to mark the domain `Verified` (typically <15 min)
5. Set a custom MAIL FROM domain so SPF aligns:
   `bounce.pages.vegastack.com` → add the MX + TXT records SES lists
6. Request production access if your account is still in the SES
   sandbox (5,000/day default after approval)

#### Cloudflare Email Sending (fallback)

The `send_email` binding requires a verified sender. From the Cloudflare
dashboard:

1. **Email** → **Email Sending** → **Add sender**
2. Add `login@pages.vegastack.com`
3. Add the DKIM record Cloudflare lists under `cf-bounce.pages.vegastack.com`
4. Wait for `Verified` state

### 1.5 R2 healthcheck object

`/api/ready` checks that R2 is reachable. Put a tiny sentinel:

```sh
echo "ok" | wrangler r2 object put \
  vegastack-pages-content/.healthcheck \
  --pipe
```

## 2. Configuration sanity check

Before the deploy, eyeball `apps/web/wrangler.jsonc`. Required state:

- `name`: `vegastack-pages` (or your fork's name)
- `compatibility_flags`: includes `"nodejs_compat"`
- `placement.mode`: `"smart"`
- `routes`: `[{"pattern": "pages.vegastack.com", "custom_domain": true}]`
- `assets.directory`: `"./dist/client"`, binding `ASSETS`
- `observability.enabled`: `true`, `head_sampling_rate: 1`, `invocation_logs: true`
- `d1_databases`: one entry binding `DB` to `vegastack-pages-db`
- `r2_buckets`: one entry binding `CONTENT` to `vegastack-pages-content`
- `ratelimits`: `ACTIONS_RL` with `simple: { limit: 60, period: 60 }`
- `send_email`: `EMAIL` with `allowed_sender_addresses` pinned
- `triggers.crons`: `["0 3 * * *", "30 3 * * *"]`
- `vars`: `VPG_RUNTIME=cloudflare`, `VPG_DEPLOYMENT_MODE=managed`,
  `VPG_EMAIL_PROVIDER=auto`, `VPG_BASE_URL=https://pages.vegastack.com`
- **NO** `images` block

## 3. Destructive cutover (production only — needs maintainer approval)

### 3.1 Drop legacy D1 tables

```sh
# Inspect first
wrangler d1 execute vegastack-pages-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# Drop every existing table (no users premise — never run with real data)
wrangler d1 execute vegastack-pages-db --remote --command \
  "SELECT 'DROP TABLE IF EXISTS ' || name || ';' AS stmt
     FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" \
  --json | jq -r '.[] | .results[].stmt' \
  | wrangler d1 execute vegastack-pages-db --remote --command -

# Verify
wrangler d1 execute vegastack-pages-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
# Expect: empty (or just sqlite_* internal tables)
```

### 3.2 Purge stale R2 prefixes (optional)

Only if you previously had pre-rebuild content under `pub/*` or
`pages/*`. Keep the bucket itself — just empty old prefixes:

```sh
# Wrangler 4.x list/delete shape (subcommand was renamed in 4.0:
# the noun is `object`, args are positional `<bucket>/<key>`, and
# `list` lives under `wrangler r2 object list <bucket>` with the
# bucket as a positional arg). For very large buckets, set up an R2
# Lifecycle Rule in the Cloudflare dashboard (Storage → R2 →
# <bucket> → Settings → Lifecycle) instead of shell-deleting.
wrangler r2 object list vegastack-pages-content --prefix pub/ \
  --remote --pipe \
  | xargs -I{} wrangler r2 object delete "vegastack-pages-content/{}" --remote
```

### 3.3 Apply the canonical schema

```sh
wrangler d1 migrations apply vegastack-pages-db --remote
# Expect: 0001_init.sql + 0002_oauth_seed.sql applied, both newly listed
# in schema_migrations.
```

## 4. Deploy

```sh
# Dry-run to catch any wrangler.jsonc/secret mismatch before the real cut
cd apps/web
pnpm exec wrangler deploy --dry-run

# Real deploy — only after the maintainer-approved gate per CLAUDE.md
pnpm exec wrangler deploy
```

The release gate in `CLAUDE.md` requires explicit approval ("ship",
"release it", "deploy it") in the same conversation as the action.
Implementation approval is **not** release approval.

## 5. Post-deploy verification

### 5.1 Liveness + readiness

```sh
curl -fsS https://pages.vegastack.com/api/health
# {"status":"ok","runtime":"cloudflare","version":"..."}

curl -fsS https://pages.vegastack.com/api/ready
# {"status":"ok","checks":{"d1":{"ok":true,...},"r2":{"ok":true,...}}}
```

### 5.2 First-run admin setup

If `setup_state.setup_complete` is `0`:

```sh
curl -X POST https://pages.vegastack.com/api/setup/complete \
  -H "content-type: application/json" \
  -d '{
    "token": "'"$VPG_SETUP_TOKEN"'",
    "email": "you@example.com",
    "display_name": "Maintainer",
    "workspace_name": "VegaStack"
  }'
```

### 5.3 Magic-link smoke

1. Visit `/app/login`
2. Submit your admin email
3. Check inbox — SES delivery within ~10s
4. Click link → land in `/app` with a session

If no email arrives in 30s, check:

```sh
wrangler tail vegastack-pages | grep -E "vpg.email|EMAIL_"
```

### 5.4 MCP smoke

From Claude / Cursor / a CLI with a configured MCP server pointing at
`https://pages.vegastack.com/mcp`:

1. Authenticate via the OAuth device flow (browser MCP client) or paste a
   token from **Settings → My Connections**.
2. Call `fetch` with `resource_id: "me"` and `include: ["workspaces"]` —
   returns the authenticated identity and accessible workspaces.
3. Call `fetch` with the workspace id and `include: ["tree"]` — returns
   the folder/page tree.
4. Call `create_page` with `{ workspace_id, title: "Smoke", source_type:
"markdown", source: "# Smoke" }` — should return a `pg_…` id.
5. Visit `https://pages.vegastack.com/p/{slug}` — should render
   immediately.

The same smoke from the CLI:

```sh
vpg --base-url https://pages.vegastack.com login
vpg --agent whoami
vpg --agent workspaces tree
vpg --agent pages create --title "Smoke" --source "# Smoke"
```

### 5.5 Cron firings

Cron triggers run at 03:00 and 03:30 UTC. After the first night:

```sh
wrangler tail vegastack-pages --format json | jq 'select(.event == "vpg.cron.completed")'
# Expect two entries: github-backup + search-reconciler
```

## 6. Ongoing operations

### 6.1 Observability — Sentry destination

Cloudflare → **Workers & Pages** → **Observability** → **Destinations**
→ **Sentry OTLP**. Connect your project's DSN. Set sampling to 100%
initially; tune down once you know what's noisy.

### 6.2 Zone rate limit rules

In the Cloudflare dashboard for `pages.vegastack.com`:

| Path               | Limit   | Window | Action       |
| ------------------ | ------- | ------ | ------------ |
| `/api/auth/*`      | 30 req  | 60s    | Block IP     |
| `/p/*`, `/f/*`     | 600 req | 60s    | Challenge IP |
| `/oauth/*`, `/mcp` | 120 req | 60s    | Block IP     |

These are zone-level rules — they fire before the Worker. The Worker's
`ACTIONS_RL` binding is a per-user counter for Astro Actions, which is
separate from zone rate limits.

### 6.3 SES dedicated IP (only if needed)

The default SES shared IP pool is fine up to ~1M emails/month. Above
that, request a dedicated IP and warm it gradually.

### 6.4 Cron-trigger health

Check `wrangler tail` daily for the first week to confirm both crons
fire reliably and report `vpg.cron.completed`. If you see
`vpg.cron.failed`, inspect the structured payload — `error` carries the
underlying message; `cron` and `job` identify which scheduled job
failed.

### 6.5 R2 storage growth + lifecycle rules

Page artifacts are content-hashed (`pages/{ws}/{pg}/rendered-{hash}.html`)
and never deleted in-place — every save adds a new artifact alongside
the previous one. Service-layer code best-effort deletes the previous
artifact on `publishFanOut` and on `publications.revoke`, but D1
write failures can leave orphans. R2 storage grows linearly with edit
frequency.

**Required** R2 lifecycle rules (Cloudflare dashboard → R2 →
`vegastack-pages-content` → Settings → Lifecycle):

| Rule name             | Prefix         | Action                                                                       |
| --------------------- | -------------- | ---------------------------------------------------------------------------- |
| `expire-old-public`   | `pub/`         | Delete objects older than **90 days**                                        |
| `expire-old-rendered` | `pages/`       | Delete objects whose key contains `/rendered-` and is older than **30 days** |
| `expire-soft-deleted` | `pages/`       | Delete objects older than **180 days** (covers soft-deleted page sources)    |
| `abort-multipart`     | (default rule) | Abort incomplete multipart uploads after **7 days**                          |

The first three are safe to enable because: (a) re-publish rewrites
the public artifact on every save and the SSR fallback
(`republishOnDemand`) regenerates anything missing; (b) the rendered
artifact is regenerated from source on the next save; (c) soft-deleted
sources are unreachable through the app and have no FK reference.

Verify each rule with a dry-run (`wrangler r2 bucket lifecycle list
<bucket>`) before enabling.

### 6.6 Backups + restore

**Source-of-truth backup (GitHub).** The 03:00 UTC cron mirrors every
workspace's pages and templates to a configured GitHub repo, giving
you an off-Cloudflare durable copy of the source. Verify the latest
sync ran:

```sh
wrangler d1 execute vegastack-pages-db --remote --command \
  "SELECT workspace_id, last_status, last_synced_at, last_error
     FROM github_sync_connections
    WHERE enabled = 1
    ORDER BY last_synced_at DESC NULLS LAST;"
# Expect: every enabled connection has last_status='ok' within the
# last 25 hours.
```

**D1 backup (Cloudflare Time Travel + manual export).**
Cloudflare D1 retains a 30-day point-in-time recovery window
automatically. For deeper backups, take a manual export weekly:

```sh
# Generate a fresh export bookmark + dump.
wrangler d1 export vegastack-pages-db --remote --output \
  "backups/d1-$(date +%Y%m%d).sql"
# Store the .sql file in your existing object-storage backup pipeline
# (S3 + glacier, GCS, etc). Each dump is ~tens of MB for a typical
# workspace fleet.
```

**Restore D1 from a manual export:**

```sh
# 1. Create a fresh D1 database (or reuse the existing one — note that
#    importing into a populated DB will fail on PK collisions; you may
#    need to TRUNCATE first; see §3.1 for the destructive flow).
wrangler d1 create vegastack-pages-db-restore

# 2. Import the SQL dump.
wrangler d1 execute vegastack-pages-db-restore --remote --file \
  "backups/d1-YYYYMMDD.sql"

# 3. Swap the binding in apps/web/wrangler.jsonc to point at the
#    restored DB, then deploy.
```

**Cloudflare Time Travel restore (within 30-day window):**

```sh
# 1. Resolve the bookmark for your target point-in-time.
wrangler d1 time-travel info vegastack-pages-db --remote
wrangler d1 time-travel restore vegastack-pages-db --remote \
  --bookmark <BOOKMARK_ID>
```

**R2 backup.** R2 doesn't have built-in cross-region replication.
For workspaces that need bucket-level snapshots, use `rclone sync` or
the Cloudflare R2 → S3 transfer recipe. The page-source ground truth
is the GitHub mirror above; the R2 rendered artifacts are
regeneratable from source so a cold-restore of D1 + sources will
re-emit them on first publish.

**Verify a restore worked.** After importing into a staging D1:

```sh
wrangler d1 execute vegastack-pages-db-restore --remote --command \
  "SELECT COUNT(*) AS pages, MAX(updated_at) AS latest FROM pages
    WHERE deleted_at IS NULL;"
# Expect: page count + latest updated_at match the export date.
```

## 7. Rollback

Cloudflare Workers keeps the previous deploy active until the new one
finishes uploading. To roll back manually:

```sh
wrangler deployments list --name vegastack-pages
wrangler rollback --name vegastack-pages --deployment-id <previous>
```

D1 rollback is harder — there is no point-in-time recovery beyond
Cloudflare's time-travel (30 days). For a deeper rollback you must
re-apply the previous schema and re-import from the GitHub backup.

## 8. Incident response

| Symptom                                 | First check                                                                                                                                                             | Remediation                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Every request 500                       | `wrangler tail` for stack traces                                                                                                                                        | Roll back deploy                                                                  |
| Magic links not arriving                | SES bounce dashboard, then `wrangler tail \| grep email`                                                                                                                | Cycle to CF send_email binding by setting `VPG_EMAIL_PROVIDER=cloudflare`         |
| `/p/[slug]` 404 for a known publication | D1 `SELECT … FROM publications WHERE id = ?` — check `revoked_at`, `latest_artifact_key`                                                                                | If artifact key is null, trigger a save on the source page to re-render + fan-out |
| `/api/ready` failing on R2              | `wrangler r2 object get vegastack-pages-content/.healthcheck`                                                                                                           | Re-create the sentinel object per §1.5                                            |
| Cron not firing                         | Inspect deployed config via `wrangler deployments view` and check `triggers.crons` in the JSON output (Wrangler 4.x removed the standalone `triggers list` subcommand). | Re-deploy with `wrangler deploy` to refresh the cron registration                 |

## 9. Documentation references

- `docs/plans/011-fresh-clean-slate.md` — original clean-slate plan
- `docs/plans/012-production-readiness-final.md` — this rebuild's executable plan
- `docs/plans/013-continuation-from-012.md` — known gaps + follow-up work
- `CLAUDE.md` — release gate + working agreement
- `.agents/skills/ship/SKILL.md` — release workflow Claude follows when shipping
