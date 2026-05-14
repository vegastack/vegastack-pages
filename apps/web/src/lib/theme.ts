export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "vpg-theme";
export const THEME_COOKIE_KEY = "vpg-theme";

export function normalizeTheme(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export function readStoredTheme(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ThemeChoice) {
  if (typeof document === "undefined") return;
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
}

export function persistTheme(theme: ThemeChoice) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${THEME_COOKIE_KEY}=${theme}; path=/; max-age=31536000; samesite=lax${secure}`;
  } catch {
    // document.cookie can throw in sandboxed contexts.
  }
  applyTheme(theme);
}
