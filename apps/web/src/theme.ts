export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_KEY = "conflux.theme";
// pre-rename storage key — read once for migration, never written again
export const LEGACY_THEME_KEY = "muiltchat.theme";
export function normalizeThemePreference(value: unknown): ThemePreference { return value === "light" || value === "dark" || value === "system" ? value : "system"; }
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme { return preference === "dark" || (preference === "system" && prefersDark) ? "dark" : "light"; }
export function getThemePreference(storage: Storage = window.localStorage): ThemePreference { try { return normalizeThemePreference(storage.getItem(THEME_KEY) ?? storage.getItem(LEGACY_THEME_KEY)); } catch { return "system"; } }
export function applyTheme(root: HTMLElement, preference: ThemePreference, prefersDark: boolean): ResolvedTheme { const resolved = resolveTheme(preference, prefersDark); root.dataset.theme = resolved; return resolved; }
export function setThemePreference(preference: ThemePreference, win: Window = window): ResolvedTheme { const normalized = normalizeThemePreference(preference); try { win.localStorage.setItem(THEME_KEY, normalized); } catch { /* storage unavailable (private mode) */ } return applyTheme(win.document.documentElement, normalized, win.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false); }
export function installTheme(win: Window = window): () => void { let preference = getThemePreference(win.localStorage); const media = win.matchMedia?.("(prefers-color-scheme: dark)"); const update = () => applyTheme(win.document.documentElement, preference, media?.matches ?? false); update(); const listener = () => { preference = getThemePreference(win.localStorage); if (preference === "system") update(); }; media?.addEventListener?.("change", listener); return () => media?.removeEventListener?.("change", listener); }

// ---- 自定义主题（#71）：令牌色板可导入/可切换 ------------------------------

export interface ThemeColors {
  ink: string; inkMuted: string; inkFaint: string;
  paper: string; surface: string;
  line: string; lineStrong: string;
  accent: string; accentDeep: string; accentSoft: string;
}
export interface CustomTheme { name: string; colors: ThemeColors }

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = [
  "ink", "inkMuted", "inkFaint",
  "paper", "surface",
  "line", "lineStrong",
  "accent", "accentDeep", "accentSoft",
] as const;
type ColorKey = (typeof COLOR_KEYS)[number];

/** CSS 变量名映射（:root 里以 rgb 通道三元组存放，支持 α 修饰符） */
const CSS_VAR: Record<ColorKey, string> = {
  ink: "--tk-ink", inkMuted: "--tk-ink-muted", inkFaint: "--tk-ink-faint",
  paper: "--tk-paper", surface: "--tk-surface",
  line: "--tk-line", lineStrong: "--tk-line-strong",
  accent: "--tk-accent", accentDeep: "--tk-accent-deep", accentSoft: "--tk-accent-soft",
};

export function hexToChannels(hex: string): string | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(hex.trim().slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** 全部 10 个键都是合法 hex 才通过；多退少补不猜默认值（导入要显式） */
export function normalizeThemeColors(value: unknown): ThemeColors | null {
  if (!value || typeof value !== "object") return null;
  const src = value as Record<string, unknown>;
  const out: Partial<Record<ColorKey, string>> = {};
  for (const key of COLOR_KEYS) {
    const v = src[key];
    if (typeof v !== "string" || !HEX.test(v.trim())) return null;
    out[key] = v.trim().toLowerCase();
  }
  return out as ThemeColors;
}

type StyleTarget = { style: { setProperty(key: string, value: string): void; removeProperty(key: string): void } };

/** 把色板写入 CSS 变量；null = 清除覆盖，回到 :root 默认（汇流蓝） */
export function applyThemeColors(root: StyleTarget = document.documentElement, colors: ThemeColors | null): void {
  for (const key of COLOR_KEYS) {
    const varName = CSS_VAR[key];
    if (!colors) root.style.removeProperty(varName);
    else {
      const channels = hexToChannels(colors[key]);
      if (channels) root.style.setProperty(varName, channels);
      else root.style.removeProperty(varName);
    }
  }
}

// 内置预设：浅色系转译自 theme-factory 主题规格（Ocean Depths / Forest Canopy / Desert Rose）
export const BUILTIN_THEMES: CustomTheme[] = [
  { name: "汇流蓝（默认）", colors: { ink: "#182234", inkMuted: "#5c677d", inkFaint: "#8b94a7", paper: "#f6f7f9", surface: "#ffffff", line: "#e4e8ef", lineStrong: "#cbd3e0", accent: "#2563eb", accentDeep: "#1e4fc4", accentSoft: "#ebf1fe" } },
  { name: "海洋深处", colors: { ink: "#0f2440", inkMuted: "#4a6079", inkFaint: "#7d93ac", paper: "#eef4f8", surface: "#ffffff", line: "#d8e3ec", lineStrong: "#b9cbdc", accent: "#0e7490", accentDeep: "#0b5a6e", accentSoft: "#e0f2f7" } },
  { name: "森林树冠", colors: { ink: "#1d2a20", inkMuted: "#52645a", inkFaint: "#84968b", paper: "#f1f6f1", surface: "#ffffff", line: "#dce7dc", lineStrong: "#b9cdb9", accent: "#2f6b4f", accentDeep: "#24523c", accentSoft: "#e3f0e6" } },
  { name: "沙漠玫瑰", colors: { ink: "#33272b", inkMuted: "#6e5a60", inkFaint: "#a08c92", paper: "#faf4f1", surface: "#ffffff", line: "#ecdfda", lineStrong: "#d6bfb8", accent: "#b76e79", accentDeep: "#96545f", accentSoft: "#f7e8e6" } },
];

export const CUSTOM_THEMES_KEY = "conflux.custom-themes";
export const ACTIVE_CUSTOM_THEME_KEY = "conflux.active-custom-theme";

export function listCustomThemes(storage: Storage = window.localStorage): CustomTheme[] {
  try {
    const raw = JSON.parse(storage.getItem(CUSTOM_THEMES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((t) => {
        const colors = normalizeThemeColors((t as CustomTheme)?.colors);
        const name = typeof (t as CustomTheme)?.name === "string" ? (t as CustomTheme).name : null;
        return name && colors ? { name, colors } : null;
      })
      .filter((t): t is CustomTheme => t !== null);
  } catch {
    return [];
  }
}

export function saveCustomTheme(theme: CustomTheme, storage: Storage = window.localStorage): void {
  const rest = listCustomThemes(storage).filter((t) => t.name !== theme.name);
  storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify([...rest, theme]));
}

export function deleteCustomTheme(name: string, storage: Storage = window.localStorage): void {
  storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(listCustomThemes(storage).filter((t) => t.name !== name)));
}

export function getActiveCustomThemeName(storage: Storage = window.localStorage): string | null {
  return storage.getItem(ACTIVE_CUSTOM_THEME_KEY);
}

/** 激活某个自定义主题（写偏好并立即应用）；null 回到默认汇流蓝 */
export function setActiveCustomTheme(name: string | null, storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  if (name === null) {
    storage.removeItem(ACTIVE_CUSTOM_THEME_KEY);
    applyThemeColors(root, null);
    return;
  }
  const theme = listCustomThemes(storage).find((t) => t.name === name) ?? BUILTIN_THEMES.find((t) => t.name === name) ?? null;
  if (!theme) return;
  storage.setItem(ACTIVE_CUSTOM_THEME_KEY, name);
  applyThemeColors(root, theme.colors);
}

/** 启动时恢复上次激活的自定义主题（无则保持 :root 默认） */
export function applySavedCustomTheme(storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  const name = getActiveCustomThemeName(storage);
  if (name === null) return;
  const theme = name === BUILTIN_THEMES[0].name ? null : listCustomThemes(storage).find((t) => t.name === name) ?? BUILTIN_THEMES.find((t) => t.name === name);
  if (name === BUILTIN_THEMES[0].name || !theme) { applyThemeColors(root, null); return; }
  applyThemeColors(root, theme.colors);
}
