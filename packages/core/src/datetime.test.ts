import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATETIME_PREFS,
  formatAbsolute,
  formatDateOnly,
  formatDateTime,
  mergeDateTimePrefs,
  readDateTimePrefs,
} from "./datetime";

const ISO = "2026-05-20T07:01:43.191Z";
const NOW = new Date("2026-05-22T07:01:43.000Z");

describe("readDateTimePrefs", () => {
  it("falls back when the blob is empty / null", () => {
    expect(readDateTimePrefs(null)).toEqual(DEFAULT_DATETIME_PREFS);
    expect(readDateTimePrefs("")).toEqual(DEFAULT_DATETIME_PREFS);
  });

  it("falls back on malformed JSON", () => {
    expect(readDateTimePrefs("{")).toEqual(DEFAULT_DATETIME_PREFS);
  });

  it("merges valid dateTime keys over the fallback", () => {
    const raw = JSON.stringify({
      dateTime: {
        dateFormat: "D MMM YYYY",
        timeFormat: "12h",
        showRelativeWithinDays: 14,
      },
    });
    expect(readDateTimePrefs(raw)).toEqual({
      dateFormat: "D MMM YYYY",
      timeFormat: "12h",
      showRelativeWithinDays: 14,
    });
  });

  it("ignores invalid values per-key", () => {
    const raw = JSON.stringify({
      dateTime: {
        dateFormat: "MMM-DDDD",
        timeFormat: "potato",
        showRelativeWithinDays: -2,
      },
    });
    expect(readDateTimePrefs(raw)).toEqual(DEFAULT_DATETIME_PREFS);
  });
});

describe("mergeDateTimePrefs", () => {
  it("returns baseline when override is empty", () => {
    expect(mergeDateTimePrefs(DEFAULT_DATETIME_PREFS, null)).toEqual(
      DEFAULT_DATETIME_PREFS,
    );
  });

  it("user override wins per-key", () => {
    const baseline = {
      dateFormat: "D MMM YYYY" as const,
      timeFormat: "24h" as const,
      showRelativeWithinDays: 7,
    };
    const override = JSON.stringify({
      dateTime: { dateFormat: "MMM D, YYYY", timeFormat: "12h" },
    });
    expect(mergeDateTimePrefs(baseline, override)).toEqual({
      dateFormat: "MMM D, YYYY",
      timeFormat: "12h",
      showRelativeWithinDays: 7,
    });
  });
});

describe("formatAbsolute", () => {
  it("renders the default workspace format in UTC", () => {
    expect(formatAbsolute(ISO, { timezone: "UTC" })).toBe(
      "May 20, 2026, 07:01",
    );
  });

  it("respects 12h", () => {
    expect(
      formatAbsolute(ISO, {
        prefs: { ...DEFAULT_DATETIME_PREFS, timeFormat: "12h" },
        timezone: "UTC",
      }),
    ).toMatch(/May 20, 2026, 0?7:01 AM/);
  });

  it("respects ISO date format", () => {
    expect(
      formatAbsolute(ISO, {
        prefs: { ...DEFAULT_DATETIME_PREFS, dateFormat: "YYYY-MM-DD" },
        timezone: "UTC",
      }),
    ).toBe("2026-05-20, 07:01");
  });

  it("returns the input when iso is invalid", () => {
    expect(formatAbsolute("not-a-date")).toBe("not-a-date");
  });
});

describe("formatDateTime", () => {
  it("renders relative inside the window", () => {
    // 5 minutes ago.
    const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(formatDateTime(recent, { now: NOW })).toBe("5m ago");
  });

  it("renders absolute outside the window", () => {
    // 30 days ago — outside the default 7-day relative window.
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    expect(
      formatDateTime(old, {
        now: NOW,
        timezone: "UTC",
      }),
    ).toMatch(/^Apr 22, 2026, /);
  });

  it("relative disabled returns absolute even for recent entries", () => {
    const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(
      formatDateTime(recent, {
        now: NOW,
        timezone: "UTC",
        prefs: { ...DEFAULT_DATETIME_PREFS, showRelativeWithinDays: 0 },
      }),
    ).toMatch(/^May 22, 2026, /);
  });
});

describe("formatDateOnly", () => {
  it("renders just the date", () => {
    expect(formatDateOnly(ISO, { timezone: "UTC" })).toBe("May 20, 2026");
  });
});
