---
"@vegastack/pages": patch
---

Fix the Cloudflare Worker deploy. The Astro 6 Cloudflare adapter
auto-provisioned a `SESSION` KV binding by default, which the release
verifier rejects (the architecture rebuild moved sessions to D1).
Configure the Astro session driver to the built-in `memory` unstorage
driver — `Astro.session` is unused, so this is purely a binding-
suppression switch. Also remove every customer-facing mention of KV
from the docs and install path; the only remaining references are the
release verifier itself and the in-code comment explaining the memory
driver choice.
