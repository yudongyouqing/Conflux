export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_KEY = "muiltchat.theme";
export function normalizeThemePreference(value: unknown): ThemePreference { return value === "light" || value === "dark" || value === "system" ? value : "system"; }
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme { return preference === "dark" || (preference === "system" && prefersDark) ? "dark" : "light"; }
export function getThemePreference(storage: Storage = window.localStorage): ThemePreference { try { return normalizeThemePreference(storage.getItem(THEME_KEY)); } catch { return "system"; } }
export function applyTheme(root: HTMLElement, preference: ThemePreference, prefersDark: boolean): ResolvedTheme { const resolved = resolveTheme(preference, prefersDark); root.dataset.theme = resolved; return resolved; }
export function setThemePreference(preference: ThemePreference, win: Window = window): ResolvedTheme { const normalized = normalizeThemePreference(preference); try { win.localStorage.setItem(THEME_KEY, normalized); } catch {} return applyTheme(win.document.documentElement, normalized, win.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false); }
export function installTheme(win: Window = window): () => void { let preference = getThemePreference(win.localStorage); const media = win.matchMedia?.("(prefers-color-scheme: dark)"); const update = () => applyTheme(win.document.documentElement, preference, media?.matches ?? false); update(); const listener = () => { preference = getThemePreference(win.localStorage); if (preference === "system") update(); }; media?.addEventListener?.("change", listener); return () => media?.removeEventListener?.("change", listener); }
