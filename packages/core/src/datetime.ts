// Workspace + per-user datetime formatting helper.
//
// Backend (D1 + service layer + every API surface) stays UTC ISO 8601
// throughout. Display surfaces — SSR pages, the editor, the trash
// list, etc. — call `formatDateTime()` with the viewer's resolved
// preferences. The client-side rewriter in
// apps/web/src/scripts/time-format.ts walks all `<time datetime=…>`
// elements and re-renders each one in the browser's local timezone
// after hydration; the SSR pass renders in UTC so the first paint is
// stable. Both code paths share this helper.
//
// Preferences:
//   • `dateFormat` — one of the five named presets below. Default:
//     "MMM D, YYYY" (e.g. "May 20, 2026"). Decided in the feature
//     interview as the workspace default; admins can change it.
//   • `timeFormat` — "24h" (default) or "12h".
//   • `showRelativeWithinDays` — when set to a positive integer, the
//     last N days render as "5m ago" / "yesterday" / "3d ago"; older
//     entries fall through to the absolute date+time. Set to 0 to
//     disable relative rendering entirely.
//
// Per-user overrides (user.preferencesJson.dateTime) win over the
// workspace defaults; null/undefined keys fall through. Anonymous
// viewers on `/p/{slug}` get the workspace defaults.

export type DateFormatKey =
  | "MMM D, YYYY" // May 20, 2026   (workspace default)
  | "D MMM YYYY" // 20 May 2026
  | "YYYY-MM-DD" // 2026-05-20
  | "DD/MM/YYYY" // 20/05/2026
  | "MM/DD/YYYY"; // 05/20/2026

export type TimeFormatKey = "12h" | "24h";

export interface DateTimePreferences {
  dateFormat: DateFormatKey;
  timeFormat: TimeFormatKey;
  /** Positive integer: render entries within N days as relative
      ("5m ago", "yesterday"). 0 disables relative rendering. */
  showRelativeWithinDays: number;
}

export const DEFAULT_DATETIME_PREFS: DateTimePreferences = {
  dateFormat: "MMM D, YYYY",
  timeFormat: "24h",
  showRelativeWithinDays: 7,
};

export const ALL_DATE_FORMATS: ReadonlyArray<DateFormatKey> = [
  "MMM D, YYYY",
  "D MMM YYYY",
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
];

export const ALL_TIME_FORMATS: ReadonlyArray<TimeFormatKey> = ["12h", "24h"];

// Parse a free-form `preferences_json` blob into a typed
// `DateTimePreferences`. Unknown keys are ignored; invalid values fall
// back to the workspace default. Robust against malformed JSON so a
// corrupt row never crashes a render.
export function readDateTimePrefs(
  raw: string | null | undefined,
  fallback: DateTimePreferences = DEFAULT_DATETIME_PREFS,
): DateTimePreferences {
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const dt =
    parsed && typeof parsed === "object" && "dateTime" in parsed
      ? (parsed as { dateTime?: unknown }).dateTime
      : null;
  if (!dt || typeof dt !== "object") return fallback;
  const record = dt as Record<string, unknown>;
  const dateFormat =
    typeof record.dateFormat === "string" &&
    (ALL_DATE_FORMATS as readonly string[]).includes(record.dateFormat)
      ? (record.dateFormat as DateFormatKey)
      : fallback.dateFormat;
  const timeFormat =
    record.timeFormat === "12h" || record.timeFormat === "24h"
      ? record.timeFormat
      : fallback.timeFormat;
  const showRelativeWithinDays =
    typeof record.showRelativeWithinDays === "number" &&
    Number.isFinite(record.showRelativeWithinDays) &&
    record.showRelativeWithinDays >= 0
      ? Math.floor(record.showRelativeWithinDays)
      : fallback.showRelativeWithinDays;
  return { dateFormat, timeFormat, showRelativeWithinDays };
}

// Merge a user preferences blob over a workspace baseline. Used when
// the per-user override should win for keys the user has set but
// the workspace value should fill in the rest.
export function mergeDateTimePrefs(
  baseline: DateTimePreferences,
  userOverride: string | null | undefined,
): DateTimePreferences {
  if (!userOverride) return baseline;
  const overridden = readDateTimePrefs(userOverride, baseline);
  return overridden;
}

// ---------- formatting ----------

interface FormatOptions {
  prefs?: DateTimePreferences;
  /** IANA timezone string. Defaults to UTC on the server, viewer's
      local on the client. */
  timezone?: string;
  /** Now-reference for relative computation. Defaults to Date.now().
      Test code passes a fixed date for determinism. */
  now?: Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatRelative(deltaMs: number): string | null {
  if (deltaMs < 0) return null; // dates in the future skip relative
  if (deltaMs < MINUTE) return "Just now";
  if (deltaMs < HOUR) {
    const minutes = Math.floor(deltaMs / MINUTE);
    return `${minutes}m ago`;
  }
  if (deltaMs < DAY) {
    const hours = Math.floor(deltaMs / HOUR);
    return `${hours}h ago`;
  }
  if (deltaMs < 2 * DAY) return "yesterday";
  const days = Math.floor(deltaMs / DAY);
  return `${days}d ago`;
}

// Intl.DateTimeFormat construction is genuinely expensive (it
// resolves the timezone, locale data, and pattern table — costing
// roughly 1–2 ms on a warm engine and up to ~10 ms cold). We
// format the same (locale, options) tuples *every* timestamp on a
// page, so cache the formatters by a string key. Cap the cache so
// a misbehaving caller can't OOM us.
const FORMATTER_CACHE_LIMIT = 64;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  // Build a stable cache key. JSON.stringify on an options object with
  // a known shape is ~200 ns; identical to a hand-rolled key for the
  // 5 + 2 + N-tz combinations we actually use.
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatterCache.size >= FORMATTER_CACHE_LIMIT) {
      // Drop the oldest entry. Map iteration order is insertion
      // order, so the first key is the eldest.
      const firstKey = formatterCache.keys().next().value;
      if (firstKey !== undefined) formatterCache.delete(firstKey);
    }
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function formatDatePart(date: Date, format: DateFormatKey, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz };
  switch (format) {
    case "MMM D, YYYY":
      opts.month = "short";
      opts.day = "numeric";
      opts.year = "numeric";
      return getFormatter("en-US", opts).format(date);
    case "D MMM YYYY":
      opts.day = "numeric";
      opts.month = "short";
      opts.year = "numeric";
      return getFormatter("en-GB", opts).format(date);
    case "YYYY-MM-DD":
      opts.year = "numeric";
      opts.month = "2-digit";
      opts.day = "2-digit";
      return getFormatter("en-CA", opts).format(date);
    case "DD/MM/YYYY":
      opts.day = "2-digit";
      opts.month = "2-digit";
      opts.year = "numeric";
      return getFormatter("en-GB", opts).format(date);
    case "MM/DD/YYYY":
      opts.month = "2-digit";
      opts.day = "2-digit";
      opts.year = "numeric";
      return getFormatter("en-US", opts).format(date);
  }
}

function formatTimePart(date: Date, format: TimeFormatKey, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: format === "12h",
  };
  return getFormatter(format === "12h" ? "en-US" : "en-GB", opts).format(date);
}

// Exposed for the test suite + the client-side rewriter so the
// cache can be cleared in scenarios that need a clean slate
// (test fixtures with frozen-clock helpers, etc.). Production
// code never needs to call this.
export function _clearFormatterCacheForTests() {
  formatterCache.clear();
}

// Render an absolute (no relative) date+time. Useful for the live
// preview in the settings card; the main `formatDateTime` consults
// `showRelativeWithinDays`.
export function formatAbsolute(
  iso: string,
  options: FormatOptions = {},
): string {
  const prefs = options.prefs ?? DEFAULT_DATETIME_PREFS;
  const tz = options.timezone ?? "UTC";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatDatePart(date, prefs.dateFormat, tz)}, ${formatTimePart(
    date,
    prefs.timeFormat,
    tz,
  )}`;
}

// Main entry point. Applies the relative-window rule, then falls
// through to the absolute renderer.
export function formatDateTime(
  iso: string,
  options: FormatOptions = {},
): string {
  const prefs = options.prefs ?? DEFAULT_DATETIME_PREFS;
  const now = options.now ?? new Date();
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (prefs.showRelativeWithinDays > 0) {
    const delta = now.getTime() - date.getTime();
    if (delta >= 0 && delta < prefs.showRelativeWithinDays * DAY) {
      const relative = formatRelative(delta);
      if (relative) return relative;
    }
  }
  return formatAbsolute(iso, options);
}

// Combined "Created at Apr 18, 2026" (no time) helper for compact
// surfaces.
export function formatDateOnly(
  iso: string,
  options: FormatOptions = {},
): string {
  const prefs = options.prefs ?? DEFAULT_DATETIME_PREFS;
  const tz = options.timezone ?? "UTC";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatDatePart(date, prefs.dateFormat, tz);
}
