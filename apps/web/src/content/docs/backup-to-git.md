---
title: Backup to Git
description: Sync workspace pages, templates, optional assets, and a manifest to a GitHub repository.
category: Administration
order: 30
lastUpdated: 2026-05-14
---

Backup to Git keeps a workspace portable. It mirrors the knowledge base into a repository through a GitHub App.

## What gets written

| Item      | Notes                                                                          |
| --------- | ------------------------------------------------------------------------------ |
| Pages     | Source files with extensions based on source type: `.md`, `.mdx`, or `.html`.  |
| Templates | Template source and metadata.                                                  |
| Assets    | Optional. Assets are included only when the workspace connection enables them. |
| Manifest  | `.vegastack-pages/manifest.json`, used to track files owned by the backup job. |

The sync never writes into `.github`, never accepts unsafe paths, and deletes only files it previously owned according to the manifest.

## Setup

An instance operator configures a GitHub App. Required environment variables:

| Variable                       | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `VPG_GITHUB_APP_ID`            | GitHub App id.                                      |
| `VPG_GITHUB_APP_SLUG`          | GitHub App slug used for the install URL.           |
| `VPG_GITHUB_APP_PRIVATE_KEY`   | GitHub App private key.                             |
| `VPG_GITHUB_APP_CLIENT_ID`     | OAuth client id.                                    |
| `VPG_GITHUB_APP_CLIENT_SECRET` | OAuth client secret.                                |
| `VPG_GITHUB_SYNC_CRON`         | Cloudflare cron schedule. Defaults to `17 2 * * *`. |

Cloudflare deploy writes `VPG_GITHUB_APP_PRIVATE_KEY` as a Worker secret when it is set during deploy. Node and Docker deployments read the same variables from the process environment.

## Workspace workflow

1. Open **Settings > General**.
2. Connect GitHub.
3. Choose a repository, branch, and root path.
4. Decide whether assets should be included.
5. Run a manual sync or wait for the scheduled sync.

Only workspace admins can configure or run backup sync.

## Sync details

- The job creates a Git tree and commit through the GitHub API.
- It records latest run status, commit SHA, counts, and errors.
- It writes pages, templates, and assets under the configured root path.
- It uses a runtime mutation lock so concurrent syncs do not race.
- It writes audit events for connection and configuration changes.

## What Backup to Git is not

It is not the primary database. The app still uses D1 or SQLite for metadata and R2 or filesystem storage for source and attachments. Git backup is an export and audit trail for workspace content.
