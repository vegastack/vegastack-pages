// Map the legacy /app/settings/sessions URL (with its `?view=mine|workspace`
// query shape) to the new Connections IA. Extracted here as a pure function
// so vitest can exercise it without booting Astro.
//
// The legacy URL is preserved as a 301 in /app/settings/sessions.astro to
// keep external bookmarks pointing somewhere useful after the 0.2.0 split.
export function legacySessionsRedirect(viewQuery: string | null): string {
  return viewQuery === "workspace"
    ? "/app/settings/connections/workspace"
    : "/app/settings/connections";
}
