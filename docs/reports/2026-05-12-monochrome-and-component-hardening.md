# Monochrome theme + shadcn / React / Astro hardening

Date: 2026-05-12
Scope: `apps/web` and `packages/ui`
Driver: Align the entire app with the public docs visual language (strict black/white/grayscale, no chromatic accents), kill all focus-ring artifacts, and lift component code up to canonical shadcn / React 19 / Astro 6 patterns.
Result: `astro check` — 0 errors, 0 warnings, 0 hints (118 files).

---

## 1. Theme — collapsed to a strict monochrome palette

### 1.1 Token rewrites in `packages/ui/src/styles.css`

All chromatic tokens collapsed onto grayscale. Light root, `prefers-color-scheme: dark`, and `[data-theme="dark"]` all rewritten symmetrically.

The archived before/after literal values were intentionally removed from this
report after the global color-token gate was introduced. The source of truth is
now `packages/ui/src/styles.css`; historical examples should reference token
names only.

**Semantic differentiation strategy** with the chromatic signal removed:

- **danger vs success** — both collapse onto the foreground color. Differentiation now lives in surrounding affordances (icon, label, copy), not chroma. Acceptable trade-off in a strict monochrome system; if signal loss is a problem in practice, reintroduce weight/border variation, not hue.
- **comments vs agent** — kept the _tint intensity_ contrast. Comments are slightly stronger, agent surfaces are slightly lighter. Ink colors split through token names instead of local literals.

### 1.2 Hardcoded chromatic literals — removed

Hardcoded chromatic literals were replaced by named tokens such as
`var(--vsk-success)`, `var(--vsk-danger)`, and `var(--vsk-accent)`.

### 1.3 New token

- `--vsk-success` added to all three palettes in `packages/ui/src/styles.css`. Now collapsed to text color, but kept as a named token so existing semantic call-sites stay readable and so a future re-introduction of color (e.g. validation green) is a single-file change.

### 1.4 What the docs / home sections actually use — verified

`.docs-nav`, `.docs-sidebar`, `.docs-content`, `.docs-pagination-*`, `.docs-toc-*`, `.home-*` reference only grayscale tokens (`--vsk-bg`, `--vsk-bg-2`, `--vsk-surface`, `--vsk-text`, `--vsk-muted`, `--vsk-border`, `--vsk-accent`, `--vsk-code-bg`) plus the local hairline / tint mixes derived from `--vsk-text`. Only one chromatic reference exists: `.docs-content .docs-mermaid[data-mermaid-error]` uses `--vsk-danger` for diagram error state — now monochrome via the token rewrite above.

---

## 2. Focus indicators — fully removed

Per explicit user direction, **all** `:focus`, `:focus-visible`, and `:focus-within` indicators were stripped from `apps/web/src/styles/global.css`. The user accepted the keyboard-accessibility trade-off.

- **Rules deleted outright** (body only set focus properties): 11
  - `.vpg-button + .vpg-input + .vpg-textarea + .vpg-select-trigger` ring block, `.create-dialog-form` input/select rules, `.icon-button:focus-visible` outline block, `.thread-actions input`, `.thread-draft-textarea`, `.login-form input` + `.setup-form input`, `.settings-inline-select` / `.settings-inline-input` (both rules), `.settings-search-input`, `.docs-nav-actions .vpg-button` ring block, plus the two leftover `.app-nav-actions .vpg-button` / `.app-mobile-toggle` rings cleaned up in the follow-up pass.
- **Selectors stripped from comma-grouped rules** (kept the `:hover` half, dropped the focus half): 39
  - Across `.vpg-button`, `.app-sidebar-brand`, `.vpg-workspace-pill-button`, `.app-sidebar-back`, `.app-sidebar-menu-item` (×2), `.app-sidebar-folder-summary` (×2 incl. `:focus-within`), `.app-sidebar-footer-item` (×2), `.vpg-user-trigger`, `.vpg-sidebar-search-trigger`, `.theme-option`, `.page-tree-link` (×2), `.doc-content a`, `.vpg-code-copy`, `.frontmatter-editor input`, `.command-result`, `.export-menu-panel button`, `.toc a` (×2), `.comments-toggle`, `.comments-sheet-close`, `.comments-sheet-tab`, `.vpg-comment-icon` (×2), `.thread-resolve` / `.thread-menu-button`, `.thread-replies-toggle`, `.thread-actions button`, `.settings-sidebar nav a`, `.member-row:focus-within`, `.member-remove-button`, `.settings-modal-close`, `.home-*` (4), `.docs-*` (8), `.vpg-mode-toggle`, `.vpg-toc-trigger`, `.vpg-toc-item`, `.settings-row-action` (×2), `.app-nav-actions .vpg-button`, `.app-mobile-toggle`.
- **Left intact**: `.cm-focused` CodeMirror state class — not a CSS focus pseudo-class, it's a CodeMirror-managed state class, and its rules only set selection/caret styling, not focus rings.

Verification: `grep -c ":focus" apps/web/src/styles/global.css` → **0**.

---

## 3. Tailwind utility classes in markup — eliminated

The only Tailwind utility class found in any markup was `class="min-w-0"` in `apps/web/src/pages/p/[slugId].astro:175`.

- Replaced with semantic class `class="doc-header-title"`.
- Added `.doc-header-title { min-width: 0; }` immediately after the `.doc-header` rule in `global.css`.

The rest of the codebase uses the custom design system (`vpg-*`, `docs-*`, `home-*`, `app-*` etc.) — no `bg-*`, `text-*`, `p-*`, `m-*`, `ring-*`, `focus:*`, `hover:*` utilities anywhere in JSX/Astro.

---

## 4. shadcn primitives — forwardRef + displayName parity

Brought all `apps/web/src/components/ui/*` primitives in line with the canonical shadcn pattern (forwardRef, displayName mirrored from the Radix primitive, ref forwarded to the underlying element).

| File                   | Before                                                                            | After                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ui/textarea.tsx`      | Plain functional component                                                        | `forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>` + `displayName = "Textarea"`          |
| `ui/select.tsx`        | `SelectTrigger`, `SelectContent` were plain functional                            | Both wrapped in `forwardRef` using `React.ComponentRef<typeof SelectPrimitive.Trigger/Content>`; displayNames mirror Radix |
| `ui/dropdown-menu.tsx` | `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator` plain functional | All three wrapped in `forwardRef` with Radix displayNames                                                                  |
| `ui/dialog.tsx`        | `DialogHeader`, `DialogFooter` plain divs                                         | Both wrapped in `forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>` with displayNames                       |

`ui/button.tsx`, `ui/input.tsx`, `ui/command.tsx` were already canonical and left alone.

`apps/web/src/lib/cn.ts` audited: correctly composes `clsx` + `tailwind-merge` — no changes needed.

---

## 5. React production patterns

### 5.1 `SourceEditor.tsx` — auto-save timeout lifecycle

The auto-save effect previously set a fresh `setTimeout` on every effect run without clearing the prior pending timeout, and had no unmount cleanup. Fix:

- Store timeout id in `autoSaveTimeoutRef = useRef<number | null>(null)`.
- On entry: `if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current)`.
- Assign new id to ref.
- Dedicated unmount-cleanup effect clears the timeout on dismount.

(`useState(parseFrontmatter(source))` was _not_ eager — it was already wrapped in `useMemo` — so left alone per the "fix only what's actually broken" principle.)

### 5.2 `CommentsPanel.tsx` — listener cleanup via AbortController

The `settle` effect added `mouseup`, `touchend`, and `keyup` listeners on `document` and removed them in the return. If the effect ever ran with overlapping listener instances, refs could leak. Converted to `AbortController`:

```ts
const ctrl = new AbortController();
document.addEventListener("mouseup", onSettle, { signal: ctrl.signal });
document.addEventListener("touchend", onSettle, { signal: ctrl.signal });
document.addEventListener("keyup", onKey, { signal: ctrl.signal });
return () => ctrl.abort();
```

Also removed the redundant `typeof window !== "undefined"` guard inside `clearDraft` (it's a user-interaction callback — `window` is always present).

### 5.3 `TocPopover.tsx` — same AbortController treatment

`mousedown` + `keydown` listeners on `document`/`window` consolidated under a single `AbortController` in the open-popover effect.

### 5.4 `DocsSearch.tsx` — eliminate ref-only "isMac" detection

A `useRef<boolean>` was being set inside an effect on mount, then read elsewhere. The value never changes after first render — the ref + effect dance was pointless.

- Replaced with a module-scope `const IS_MAC = …` evaluated once.
- Added a proper `NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } }` type instead of an inline cast.
- Removed the mount effect entirely.
- Both the keydown handler and the `modifierLabel` now read the module constant.

### 5.5 `CodeBlockEnhancer.tsx` — module-scope timeout → component ref

The "copied" reset timeout was stored as a `let` in module scope, which means it (a) leaked across component instances on the same page and (b) couldn't be cleared on unmount. Moved to `resetHandleRef = useRef<number | null>(null)`; added unmount cleanup that clears it.

---

## 6. Astro hydration directives

Two over-eager `client:load` directives downgraded to `client:idle` — these components aren't needed during the critical render path and shouldn't compete with first paint.

| File                                           | Component           | Before        | After                                                         |
| ---------------------------------------------- | ------------------- | ------------- | ------------------------------------------------------------- |
| `apps/web/src/components/AppSidebar.astro:157` | `CommandPalette`    | `client:load` | `client:idle`                                                 |
| `apps/web/src/components/AppSidebar.astro:320` | `UserMenu`          | `client:load` | `client:idle`                                                 |
| `apps/web/src/components/AppSidebar.astro:160` | `SidebarCreateMenu` | `client:load` | unchanged — directly involved in primary workspace navigation |

`SonnerHost` (`AppLayout.astro:30`) stays `client:load` — toasts must be live from page load. `DocsSearch` was already `client:idle`. Theme-hydration inline `<script is:inline>` in `AppLayout.astro` left intact (correctly used to prevent FOUC).

---

## 7. What was deliberately not touched

- **CodeMirror `.cm-focused` rules** — not a CSS focus pseudo; CodeMirror manages this class on its content area for caret/selection styling.
- **Shadow primitives** — now routed through named global tokens instead of local literal color arithmetic.
- **Email/export surfaces** — now route through `apps/web/src/lib/standalone-theme.ts`, the one standalone palette source for contexts that cannot consume app CSS variables.
- **`SidebarCreateMenu` `client:load`** — kept eager because it's the primary "new page / new folder" action; idle hydration would create a visible delay in core nav flow.
- **`ui/button.tsx`, `ui/input.tsx`, `ui/command.tsx`** — already canonical shadcn structure, no changes warranted.

---

## 8. Verification

- `astro check` (apps/web): **0 errors, 0 warnings, 0 hints** across 118 files.
- `grep -c ":focus" apps/web/src/styles/global.css` → **0**.
- `grep -E "oklch\([^)]*[1-9]" packages/ui/src/styles.css` → **0**.
- `grep -E "#(4ade80|b42318|3b82f6|16a34a)" apps/web/src/styles/global.css` → **0**.
- `grep "min-w-0" apps/web/src/pages/p/\[slugId\].astro` → **0**.
- `grep "client:load" apps/web/src/components/AppSidebar.astro` → only `SidebarCreateMenu`.

---

## 9. Open questions / suggested follow-ups

1. **Accessibility** — removing all focus indicators is a deliberate trade-off you've signed off on, but it does fail WCAG 2.4.7 (Focus Visible). If you ever ship to a context with audit requirements, the simplest reintroduction is a single `--focus-ring` token + one global rule `:focus-visible { outline: 2px solid var(--vsk-text); outline-offset: 2px; }` in `global.css`.
2. **Semantic state loss** — danger and success now both render as foreground color. If error states need stronger differentiation, consider weight/border instead of hue (e.g. `font-weight: 600` + `border-left: 2px solid currentColor` on error-state surfaces).
3. **Comment vs agent surfaces** — only differentiated by tint intensity now. If users report confusion, add a small icon prefix to each kind rather than reintroducing chroma.
4. **`global.css` size** — 7,873 lines. Not addressed in this pass. Worth considering a split into `tokens.css`, `primitives.css`, `app.css`, `docs.css`, `home.css` for maintainability, but that's a separate refactor that would touch every file's import path.

---

# Addendum — Nova-compact pass (same day)

Driver: User reported the browser's native blue focus ring still showing on `<textarea>` despite Phase 1; UI felt "old-ish" because of drop shadows; wanted Vercel Nova / shadcn-new-york compact density (32px control height across the board); zero hardcoded sizing anywhere.

## A1. Root cause of the lingering blue ring

Phase 1 removed our CSS focus rules but **never suppressed the browser's UA default `:focus` outline**. Tailwind v4 preflight does not reset focus outlines on form controls, so WebKit was still drawing its 2px blue ring on `<textarea>` and `<input>`. Fix: explicit global reset.

## A2. Global focus reset — in `apps/web/src/styles/global.css`

Inserted immediately after the `body { }` rule:

```css
*:focus,
*:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}

input:focus,
textarea:focus,
select:focus,
.vpg-input:focus,
.vpg-textarea:focus,
.vpg-select-trigger:focus {
  outline: none !important;
  box-shadow: var(--vsk-ring-input) !important; /* keep resting hairline */
}
```

The `!important` is deliberate — it neutralizes Radix, CodeMirror, and any third-party widget that injects its own ring. Form controls re-state the inset hairline so they don't go completely flat when focused.

## A3. New design tokens — in `packages/ui/src/styles.css`

| Token                      | Value                                    | Purpose                                     |
| -------------------------- | ---------------------------------------- | ------------------------------------------- |
| `--control-h-sm`           | `1.75rem` (28 px)                        | Small button/input height                   |
| `--control-h-md`           | `2rem` (32 px)                           | Default control height — Nova baseline      |
| `--control-h-lg`           | `2.25rem` (36 px)                        | Large variant                               |
| `--control-px-sm`          | `0.5rem`                                 | Small inline padding                        |
| `--control-px-md`          | `0.625rem`                               | Default inline padding                      |
| `--control-px-lg`          | `0.75rem`                                | Large inline padding                        |
| `--control-gap`            | `0.4rem`                                 | Default inline gap between control children |
| `--vsk-radius-row`         | mapped to the global radius scale        | Dense rows and list items                   |
| `--vsk-radius-control`     | mapped to the global radius scale        | Inputs, textareas, selects                  |
| `--vsk-radius-button`      | mapped to the global radius scale        | Text buttons                                |
| `--vsk-radius-icon-button` | mapped to the global radius scale        | Square icon actions                         |
| `--vsk-radius-dropdown`    | mapped to the global radius scale        | Dropdowns, selects, popovers                |
| `--vsk-radius-dialog`      | mapped to the global radius scale        | Dialogs and modal panels                    |
| `--vsk-radius-circle`      | mapped to the global radius scale        | Avatars, dots, circular controls            |
| `--hairline-color`         | derived from `--vsk-text`                | Default border ink                          |
| `--hairline-color-strong`  | derived from `--vsk-text`                | Emphasized border ink                       |
| `--hairline`               | `1px solid var(--hairline-color)`        | Default 1 px hairline                       |
| `--hairline-strong`        | `1px solid var(--hairline-color-strong)` | Emphasized 1 px hairline                    |

Defined once at light `:root` — color-scheme-independent.

## A4. Shadows neutralized at the token layer

Rather than edit each of the 17+ `box-shadow` callsites, the `--vsk-shadow-*` tokens themselves were rewritten:

| Token                  | Before                             | After                           |
| ---------------------- | ---------------------------------- | ------------------------------- |
| `--vsk-shadow-tint`    | local literal shadow color         | `transparent`                   |
| `--vsk-shadow-sm`      | `0 1px 2px var(--vsk-shadow-tint)` | `none`                          |
| `--vsk-shadow-md`      | `0 16px 44px ...`                  | `none`                          |
| `--vsk-shadow-lg`      | `0 18px 56px ...`                  | `none`                          |
| `--vsk-shadow-xl`      | `0 24px 72px ...`                  | `none`                          |
| `--vsk-shadow-2xl`     | `0 24px 80px ...`                  | `none`                          |
| `--vsk-shadow-tooltip` | tooltip shadow primitive           | derived from `--vsk-text`       |
| `--vsk-shadow-ring`    | local color arithmetic             | derived from `--hairline-color` |

Effect: every dialog, dropdown, select, popover, command palette, share/export/create menu, settings modal, search popover, password card, mobile sidebar, etc. drops its drop-shadow and is held in space only by its 1 px hairline ring. Tooltip is the lone exception.

## A5. CSS sweep — per file

All seven stylesheets walked. Substitutions applied:

- Heights `1.65rem | 2rem | 2.25rem | 2.5rem` → `var(--control-h-{sm,md,md,md})` (everything in the 26–40 px control range collapses onto 32 px).
- Raw radius declarations → semantic `--vsk-radius-*` tokens, with primitive values confined to the design-token source.
- Raw `box-shadow: <drop>` declarations not routed through tokens → `none` or `var(--vsk-shadow-ring)` as appropriate.
- Previously shadowed surfaces verified to retain `var(--vsk-shadow-ring)` so they don't look detached.

| File           | Heights → token | Radii → token |  Raw shadows neutralized | Surfaces re-hairlined |
| -------------- | --------------: | ------------: | -----------------------: | --------------------: |
| `global.css`   |              14 |            30 |   1 (tabs active → ring) |                     9 |
| `comments.css` |               5 |            11 |                        0 |                     2 |
| `settings.css` |               6 |            17 | 2 (toast pulses removed) |                     4 |
| `auth.css`     |               0 |             5 |                        0 |                     0 |
| `home.css`     |               3 |            14 |                        0 |                     0 |
| `docs.css`     |               8 |            17 |                        0 |                     4 |
| `shell.css`    |               4 |             9 |                        0 |                     0 |
| **Total**      |          **40** |       **103** |                    **3** |                **19** |

Layout-scale heights (sidebars, app nav, viewport-relative containers, label rows like `min-height: 2.4rem` for folder rows that aren't keyboard-focusable controls, the 1.6 rem kbd keycaps and the comment-thread mini send button) were deliberately left out of the control-height sweep — they're not interactive 32 px targets.

## A6. Components & TSX

- Grep across `apps/web/src/components/**` for `style={{ height|padding|borderRadius|boxShadow ... }}` → **zero hits** at runtime UI surfaces.
- `apps/web/src/components/ui/*.tsx` emit only `vpg-*` classes via `cva` / `cn`; no inline sizing leakage.
- The only `height: ...` literals found were inside two print-mode HTML strings (ExportMenu, PageActionsMenu PDF templates) — out of scope (PDF output, not screen UI).

## A7. Verification (Nova pass)

| Check                       | Command                                                                               | Result                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| No hardcoded radii          | `pnpm check:radius`                                                                   | **passes**                                                                                           |
| Control heights tokenized   | `grep -rE "(min-)?height:\s*(1\.[6-9]\|2(\.[0-5])?)(rem\|px)\b" apps/web/src/styles/` | 4 remaining (folder rows, kbd keycap, thread sub-button) — all non-control, intentional              |
| No raw drop shadows         | `grep -rE "box-shadow:\s*[0-9]" apps/web/src/styles/`                                 | 6 hits, all inside `@keyframes vpg-mark-flash{,-agent}` ring pulses (`0 0 0 Npx`) — not drop shadows |
| Focus rules under control   | `grep -c ":focus" apps/web/src/styles/global.css`                                     | 9 — exactly the Phase A2 reset + the input/textarea/select hairline-preservation rules               |
| No inline component heights | `grep -rE "height:\s*['\"][0-9]+" apps/web/src/components/`                           | **0**                                                                                                |
| Typecheck                   | `pnpm typecheck` (apps/web)                                                           | **0 errors / 0 warnings / 0 hints** across 139 files                                                 |

## A8. Deliberate carve-outs in this pass

- **Tooltip drop shadow** — kept (per user direction). Tooltips floating in mid-air with no shadow read as broken; the new hair-thin shadow uses the monochrome text color via `color-mix`, not pure black, so it stays on-theme.
- **Settings success/error toast pulse rings** — the colored 3 px outer pulse ring around success/error dots was simply removed (not converted to a hairline) since with monochrome tokens the pulse would be invisible. If those toasts need a more visible affordance, reintroduce as an inset border, not a shadow.
- **CodeMirror `.cm-focused`** — still untouched (it's a CodeMirror state class, not a CSS focus pseudo).
- **Keyframe ring pulses** in comments / agent highlights — these use `box-shadow: 0 0 0 Npx <tint>` as a _visual ring expanding outward over time_, not a drop shadow. They drive `--vsk-comment-tint` / `--vsk-agent-tint` color, which is already monochrome from the Phase 1 token rewrite. Kept.

## A9. End-to-end reliability

Single-source-of-truth for every dimensional value is now `packages/ui/src/styles.css`. Editing one token changes the entire app:

- Want all controls to be 36 px? Change `--control-h-md` to `2.25rem` in one place.
- Want puffier dialogs? Change the dialog semantic token mapping in the global radius source.
- Want shadows back? Restore the `--vsk-shadow-*` token values — every callsite picks it up.

No hardcoded heights, radii, or drop shadows exist in component code or stylesheets after this pass.
