import { describe, expect, it } from "vitest";
import { legacySessionsRedirect } from "../../../../lib/settings-redirects";

// Regression coverage for the Sessions → Connections split in 0.2.0.
//
// The actual SSR redirect lives in /app/settings/sessions.astro; the URL
// resolution it relies on is exercised here through a tiny pure-function
// helper so vitest doesn't need to load the Astro page module.
//
// Mapping contract:
//   /app/settings/sessions                 → /app/settings/connections
//   /app/settings/sessions?view=mine       → /app/settings/connections
//   /app/settings/sessions?view=workspace  → /app/settings/connections/workspace
//   /app/settings/sessions?view=anything   → /app/settings/connections
describe("legacySessionsRedirect (sessions → connections URL map)", () => {
  it("maps no `view` query to the personal connections page", () => {
    expect(legacySessionsRedirect(null)).toBe("/app/settings/connections");
    expect(legacySessionsRedirect("")).toBe("/app/settings/connections");
  });

  it("maps view=mine to the personal connections page", () => {
    expect(legacySessionsRedirect("mine")).toBe("/app/settings/connections");
  });

  it("maps view=workspace to the admin workspace-wide page", () => {
    expect(legacySessionsRedirect("workspace")).toBe(
      "/app/settings/connections/workspace",
    );
  });

  it("falls back to the personal page for unrecognized view values", () => {
    expect(legacySessionsRedirect("garbage")).toBe("/app/settings/connections");
    // Case-sensitive on purpose: the original ?view= query is documented
    // lowercase. Surfacing a 404-style fallback for typos is fine.
    expect(legacySessionsRedirect("Workspace")).toBe(
      "/app/settings/connections",
    );
  });
});
