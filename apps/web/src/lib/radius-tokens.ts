/**
 * Standalone radius tokens for HTML that renders outside the app stylesheet
 * cascade, such as print/export documents and transactional email.
 *
 * App UI should use CSS semantic tokens from packages/ui/src/styles.css.
 * Keep these values aligned with the matching app tokens:
 * - code/button: --vsk-radius-code / --vsk-radius-button
 * - card: --vsk-radius-card
 */
export const standaloneRadius = {
  button: "8px",
  card: "12px",
  code: "8px",
} as const;
