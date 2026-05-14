export const standalonePalette = {
  bg: "oklch(0.985 0 0)",
  surface: "oklch(0.998 0 0)",
  surfaceMuted: "oklch(0.956 0 0)",
  text: "oklch(0.155 0 0)",
  muted: "oklch(0.52 0 0)",
  mutedFaint: "oklch(0.66 0 0)",
  border: "oklch(0.895 0 0)",
  accent: "oklch(0.205 0 0)",
  accentForeground: "oklch(0.982 0 0)",
} as const;

export const standaloneLine = {
  border: `1px solid ${standalonePalette.border}`,
} as const;

export const standaloneTypography = {
  body: 'font: 16px/1.65 "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
  h1: "font-size: 1.875rem; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em;",
  h2: "font-size: 1.5rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em;",
  h3: "font-size: 1.25rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.01em;",
  h4: "font-size: 1rem; font-weight: 500; line-height: 1.4;",
  pre: 'font: 13px/1.55 "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
  code: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  footer: "font:12px/1.4 'Geist',ui-sans-serif,system-ui,sans-serif",
} as const;

export const standaloneEmailStyle = {
  bodyFont:
    "font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
  cardLine: `border:${standaloneLine.border}`,
  title: "font-size:18px;font-weight:700;letter-spacing:-0.01em",
  body: "font-size:14px;line-height:1.6",
  action: "font-size:14px;font-weight:600",
  url: "font-size:12px;line-height:1.5",
  finePrint: "font-size:12px",
} as const;

export function standaloneFooterStyle() {
  return [
    "margin-top:56px",
    "padding-top:14px",
    `border-top:${standaloneLine.border}`,
    `color:${standalonePalette.muted}`,
    standaloneTypography.footer,
  ].join(";");
}
