# @vegastack/pages

## 0.1.0

Initial public release of the VegaStack Pages CLI.

### Added

- Native `vpg` launcher distributed through `@vegastack/pages` with platform-specific optional packages.
- Auth and workspace commands for login, logout, identity checks, workspace listing, and workspace selection.
- Page commands for create, get, rendered output, source update, optimistic patch, validate, move, snapshots, version listing, and restore.
- Template commands for list, show, render, create, update, and `vpg create --template` page creation.
- Review commands for listing comments, creating anchored comments, replying, resolving, unresolving, completing, deleting threads, updating anchors, reading events, and waiting on review state.
- Publication commands for public page/folder links, publication updates, revocation, and default comment permission support.
- Workspace utilities for tree, search, export, attachment upload, member invites, setup doctor, deploy bootstrap, and update metadata.
- Portable VegaStack Pages skill commands for path, print, doctor, install, and update so agents can use the same MCP/CLI workflow outside this repo.

### Fixed

- Keep launcher version output aligned with the published package version.
