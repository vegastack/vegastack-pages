// "Date & time" preferences card for Settings → General (workspace
// default) and Settings → Profile (per-user override).
//
// Visually identical to other settings cards (Version retention,
// Backup to Git, etc.): uses the same `.settings-card` shell,
// `.settings-card-header`, `.settings-card-form` grid, `.vpg-field`
// labels, `.vpg-input` controls, and `.vpg-button` action button.
// No custom CSS classes leak out — the only addition is a small
// inline preview list that reuses the muted-line + settings-status
// typography.
//
// Three knobs (per the feature interview decision):
//   • dateFormat — 5 named presets (default: "MMM D, YYYY")
//   • timeFormat — 12h or 24h
//   • showRelativeWithinDays — checkbox, 7d window or off
//
// Save uses the same optimistic-then-confirm pattern as the other
// settings forms. A spinner + status message live in the same DOM
// shape so the visual feedback rhymes with the rest of the page.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ALL_DATE_FORMATS,
  ALL_TIME_FORMATS,
  formatDateTime,
  type DateFormatKey,
  type DateTimePreferences,
  type TimeFormatKey,
} from "@vegastack/pages-core";

const DATE_FORMAT_LABELS: Record<DateFormatKey, string> = {
  "MMM D, YYYY": "May 20, 2026  (MMM D, YYYY)",
  "D MMM YYYY": "20 May 2026  (D MMM YYYY)",
  "YYYY-MM-DD": "2026-05-20  (ISO)",
  "DD/MM/YYYY": "20/05/2026  (DD/MM/YYYY)",
  "MM/DD/YYYY": "05/20/2026  (MM/DD/YYYY)",
};

const TIME_FORMAT_LABELS: Record<TimeFormatKey, string> = {
  "12h": "12-hour (2:32 PM)",
  "24h": "24-hour (14:32)",
};

export interface DateTimePreferencesCardProps {
  scope: "workspace" | "user";
  initial: DateTimePreferences;
  endpoint: string;
  workspaceDefault?: DateTimePreferences;
  canEdit?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function DateTimePreferencesCard({
  scope,
  initial,
  endpoint,
  workspaceDefault,
  canEdit = true,
}: DateTimePreferencesCardProps) {
  const [draft, setDraft] = useState<DateTimePreferences>(initial);
  const [saved, setSaved] = useState<DateTimePreferences>(initial);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [previewTime, setPreviewTime] = useState(() => new Date());

  // Tick the preview's relative entries once a minute so the admin
  // sees the format behave (e.g. "Just now → 5m ago") without a
  // reload. Cheap; identical to the editor's autosave heartbeat.
  useEffect(() => {
    const id = window.setInterval(() => setPreviewTime(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const dirty = useMemo(
    () =>
      draft.dateFormat !== saved.dateFormat ||
      draft.timeFormat !== saved.timeFormat ||
      draft.showRelativeWithinDays !== saved.showRelativeWithinDays,
    [draft, saved],
  );

  const matchesWorkspaceDefault = useMemo(() => {
    if (!workspaceDefault) return false;
    return (
      draft.dateFormat === workspaceDefault.dateFormat &&
      draft.timeFormat === workspaceDefault.timeFormat &&
      draft.showRelativeWithinDays === workspaceDefault.showRelativeWithinDays
    );
  }, [draft, workspaceDefault]);

  const previewSamples = useMemo(() => {
    const now = previewTime;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return [
      {
        label: "Just edited",
        iso: new Date(now.getTime() - 5 * 60_000).toISOString(),
        tz,
      },
      {
        label: "Updated yesterday",
        iso: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
        tz,
      },
      {
        label: "Published 90 days ago",
        iso: new Date(now.getTime() - 90 * 24 * 60 * 60_000).toISOString(),
        tz,
      },
    ];
  }, [previewTime]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (status.kind === "saving" || !dirty) return;
    setStatus({ kind: "saving" });
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dateTime: draft }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          payload?.error?.message ?? "Could not save preferences.",
        );
      }
      setSaved(draft);
      setStatus({ kind: "success", message: "Saved." });
      toast.success(
        scope === "workspace"
          ? "Workspace date & time saved"
          : "Date & time preferences saved",
      );
      window.setTimeout(() => setStatus({ kind: "idle" }), 2_400);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save preferences.";
      setStatus({ kind: "error", message });
      toast.error(message);
    }
  }

  return (
    <section className="settings-card" aria-labelledby="general-datetime-h">
      <header className="settings-card-header">
        <h2 id="general-datetime-h">Date &amp; time</h2>
        <p>
          {scope === "workspace"
            ? "Workspace default for how timestamps display across pages, the trash, and audit logs. Each member can override these in their profile."
            : "Your personal override for how timestamps display. Falls back to the workspace default for anything you haven't set."}
        </p>
      </header>
      <form
        className="settings-card-form"
        onSubmit={onSubmit}
        aria-busy={status.kind === "saving"}
      >
        <label className="vpg-field">
          <span>Date format</span>
          <select
            className="vpg-input"
            value={draft.dateFormat}
            disabled={!canEdit || status.kind === "saving"}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                dateFormat: event.target.value as DateFormatKey,
              }))
            }
          >
            {ALL_DATE_FORMATS.map((option) => (
              <option key={option} value={option}>
                {DATE_FORMAT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="vpg-field">
          <span>Time format</span>
          <select
            className="vpg-input"
            value={draft.timeFormat}
            disabled={!canEdit || status.kind === "saving"}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                timeFormat: event.target.value as TimeFormatKey,
              }))
            }
          >
            {ALL_TIME_FORMATS.map((option) => (
              <option key={option} value={option}>
                {TIME_FORMAT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-inline-toggle">
          <input
            type="checkbox"
            checked={draft.showRelativeWithinDays > 0}
            disabled={!canEdit || status.kind === "saving"}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                showRelativeWithinDays: event.target.checked ? 7 : 0,
              }))
            }
          />
          <span className="settings-inline-toggle-label">
            Show relative time for the last 7 days (older entries fall back to
            the absolute date)
          </span>
        </label>
        <div
          className="settings-card-datetime-preview"
          aria-live="polite"
          aria-label="Date and time preview"
        >
          <ul>
            {previewSamples.map((sample) => (
              <li key={sample.label}>
                <span className="settings-card-datetime-preview-label">
                  {sample.label}
                </span>
                <span className="settings-card-datetime-preview-value">
                  {formatDateTime(sample.iso, {
                    prefs: draft,
                    timezone: sample.tz,
                    now: previewTime,
                  })}
                </span>
              </li>
            ))}
          </ul>
          {scope === "user" && matchesWorkspaceDefault && (
            <p className="settings-muted-line">
              Currently matches the workspace default.
            </p>
          )}
        </div>
        <button
          className="vpg-button vpg-button-primary vpg-button-md"
          type="submit"
          disabled={!canEdit || !dirty || status.kind === "saving"}
          data-pending={status.kind === "saving" ? "true" : undefined}
        >
          <span className="settings-button-label">
            {scope === "workspace" ? "Save defaults" : "Save preferences"}
          </span>
          <span className="settings-button-spinner-wrap">
            <span className="settings-button-spinner" aria-hidden="true" />
          </span>
        </button>
        {status.kind === "success" && (
          <p className="settings-status" data-state="success">
            {status.message}
          </p>
        )}
        {status.kind === "error" && (
          <p className="settings-status" data-state="error">
            {status.message}
          </p>
        )}
      </form>
    </section>
  );
}
