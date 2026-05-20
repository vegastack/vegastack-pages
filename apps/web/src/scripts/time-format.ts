// Client-side timestamp rewrite.
//
// Server-rendered surfaces emit `<time datetime="<ISO>">` with the
// raw UTC ISO as the text. After hydration this script walks every
// such element and rewrites the visible text using the workspace +
// per-user datetime preferences resolved in the viewer's browser
// timezone.
//
// Why client-side: the server has no timezone for anonymous
// visitors; baking a tz into SSR would lock them to UTC. Rendering
// in the browser keeps each viewer in their own local time without
// per-request roundtrips. The SSR fallback (UTC ISO) is still
// valid + readable so no-JS visitors aren't broken.
//
// Preferences come from a `<meta name="vpg-datetime-prefs">` tag
// emitted by AppLayout. We parse it once and reuse the parsed shape
// for every `<time>` in the DOM. The script re-runs on Astro
// `page-load` so ClientRouter view-transitions stay consistent.
//
// Opt-out: `<time data-vpg-time-raw>` keeps its server-rendered
// text (e.g. inside a code block where we want the literal ISO).

import {
  DEFAULT_DATETIME_PREFS,
  formatAbsolute,
  formatDateTime,
  readDateTimePrefs,
  type DateTimePreferences,
} from "@vegastack/pages-core";

const REWRITTEN_ATTR = "data-vpg-time-rewritten";

// Resolve once per script load — `Intl.DateTimeFormat()` itself is
// expensive when constructed repeatedly. The timezone is stable for
// the session so we cache it module-scope.
const RESOLVED_TZ =
  (typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC") || "UTC";

// Cached parsed preferences. Re-parsed only when the meta tag's
// content actually changes (e.g. on ClientRouter navigation between
// pages with different effective prefs).
let cachedPrefsContent = "";
let cachedPrefs: DateTimePreferences = DEFAULT_DATETIME_PREFS;

function readPrefs(): DateTimePreferences {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="vpg-datetime-prefs"]',
  );
  const content = meta?.content ?? "";
  if (content === cachedPrefsContent) return cachedPrefs;
  cachedPrefsContent = content;
  cachedPrefs = content ? readDateTimePrefs(content) : DEFAULT_DATETIME_PREFS;
  return cachedPrefs;
}

function rewriteOne(
  element: HTMLTimeElement,
  prefs: DateTimePreferences,
  tz: string,
  now: Date,
) {
  if (element.hasAttribute("data-vpg-time-raw")) return;
  const iso = element.getAttribute("datetime") ?? "";
  if (!iso) return;
  // formatDateTime already caches its underlying Intl formatters by
  // (locale, options) tuple, so this is a hot-path-cheap call.
  element.textContent = formatDateTime(iso, { prefs, timezone: tz, now });
  element.setAttribute(REWRITTEN_ATTR, "true");
  // Hover-title keeps the absolute date+time available even when
  // the visible text is relative ("5m ago" → tooltip shows the
  // exact timestamp).
  if (!element.hasAttribute("title")) {
    element.setAttribute("title", formatAbsolute(iso, { prefs, timezone: tz }));
  }
}

function rewriteAll(prefs: DateTimePreferences, tz: string, now: Date) {
  document
    .querySelectorAll<HTMLTimeElement>("time[datetime]")
    .forEach((element) => rewriteOne(element, prefs, tz, now));
}

let tickHandle: number | null = null;
function ensureTicker() {
  if (tickHandle !== null) return;
  // 60s cadence keeps "Just now → 5m ago" honest without hammering
  // the main thread. Only relative entries actually change between
  // ticks; absolute renders are no-ops thanks to text === text.
  tickHandle = window.setInterval(() => {
    rewriteAll(readPrefs(), RESOLVED_TZ, new Date());
  }, 60_000);
}

function run() {
  rewriteAll(readPrefs(), RESOLVED_TZ, new Date());
  ensureTicker();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else {
  run();
}
document.addEventListener("astro:page-load", run);
// Surfaces that mutate a `<time>` element's datetime attribute in
// place (the page-header "Edited X ago" label after a save,
// version-history after restore, etc.) dispatch this event so we
// re-walk instead of waiting for the next 60s tick.
window.addEventListener("vpg:time-refresh", run);

// Some surfaces (TrashList rows, comment threads, etc.) inject new
// <time> nodes via React after hydration. A lightweight observer
// catches those without per-island wiring; we look up new `<time>`
// children only and rewrite each one in place (avoids re-walking
// the whole document on every DOM tweak).
const observer = new MutationObserver((mutations) => {
  const prefs = readPrefs();
  const now = new Date();
  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (!(node instanceof Element)) return;
      if (node instanceof HTMLTimeElement && node.hasAttribute("datetime")) {
        rewriteOne(node, prefs, RESOLVED_TZ, now);
      }
      node
        .querySelectorAll?.<HTMLTimeElement>("time[datetime]")
        .forEach((element) => rewriteOne(element, prefs, RESOLVED_TZ, now));
    });
  }
});
observer.observe(document.body, { childList: true, subtree: true });

export {};
