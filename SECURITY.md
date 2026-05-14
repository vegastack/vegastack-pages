# Security Policy

Report suspected vulnerabilities privately. Do not open a public issue with exploit details, tokens, database contents, or private tenant data.

## Reporting

Use GitHub private vulnerability reporting if it is enabled for the repository:

```text
https://github.com/vegastack/vegastack-pages/security
```

If private reporting is unavailable, open a public issue with only a minimal summary and ask for a private disclosure channel.

Include:

- Affected version, commit, or deployment mode.
- Reproduction steps with test data only.
- Impact and affected boundaries.
- Any logs or traces with secrets redacted.

## Scope

In scope:

- Authentication, authorization, session, and setup flows.
- Public share links, guest access, and comment permissions.
- MCP endpoint and token handling.
- Stored XSS, content rendering, attachment handling, and export paths.
- Backup to Git repository path handling and GitHub App token handling.
- Cloudflare and Docker self-host deployment defaults.

Out of scope:

- Denial-of-service findings that rely on unrealistic traffic volume without a product-specific weakness.
- Reports requiring access to accounts, workspaces, or infrastructure you do not own.
- Vulnerabilities in third-party services unless VegaStack Pages uses them in an unsafe way.

## Handling

Maintainers should acknowledge valid private reports, reproduce the issue, patch with tests when practical, and publish a security note when the fix is released.
