/** 可注入的主题根：真实 HTMLElement 或测试用的结构化替身 */
type ThemeRoot = { dataset: Record<string, string | undefined>; style: { setProperty(key: string, value: string): void; removeProperty(key: string): void } };
/** 深浅同步到 Electron 原生控件（macOS 菜单栏/右键菜单跟随应用主题而非 OS 外观）；
 *  纯浏览器环境没有该桥，静默跳过 */
function syncNativeChrome(mode: "dark" | "light"): void {
  const bridge = (globalThis as { confluxDesktop?: { setNativeTheme?: (mode: string) => void } })
    .confluxDesktop;
  bridge?.setNativeTheme?.(mode);
}

/** 启动即按激活色板落令牌（幂等）。 */
export function installTheme(win: Window = window): () => void { refreshTokenApplication(win.localStorage, win.document.documentElement); return () => {}; }

// ---- 自定义主题：令牌色板可导入/可切换 -------------------------------------

export interface ThemeColors {
  ink: string;
  paper: string; surface: string;
  line: string; lineStrong: string;
  accent: string; accentDeep: string; accentSoft: string;
}
export interface CustomTheme { name: string; colors: ThemeColors }

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = [
  "ink",
  "paper", "surface",
  "line", "lineStrong",
  "accent", "accentDeep", "accentSoft",
] as const;
type ColorKey = (typeof COLOR_KEYS)[number];

/** CSS 变量名映射（:root 里以 rgb 通道三元组存放，支持 α 修饰符） */
const CSS_VAR: Record<ColorKey, string> = {
  ink: "--tk-ink",
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

function relativeLuminance(hex: string): number {
  const channels = hexToChannels(hex)?.split(" ").map(Number) ?? [0, 0, 0];
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/** Use one legible foreground through both the normal and hover button states.
 * Derived at application time so imported palettes keep their eight-key format. */
function accentForeground(colors: ThemeColors): string {
  const backgrounds = [colors.accent, colors.accentDeep].map(relativeLuminance);
  const score = (foreground: string) => {
    const luminance = relativeLuminance(foreground);
    return Math.min(
      ...backgrounds.map((background) =>
        (Math.max(luminance, background) + 0.05) / (Math.min(luminance, background) + 0.05)),
    );
  };
  return score("#ffffff") >= score("#0d121c") ? "255 255 255" : "13 18 28";
}

/** 全部 8 个必需键都是合法 hex 才通过；legacy 键忽略，多退少补不猜默认值 */
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

type StyleTarget = ThemeRoot;

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
  if (colors) root.style.setProperty("--tk-on-accent", accentForeground(colors));
  else root.style.removeProperty("--tk-on-accent");
}

// 内置预设：默认采用 Paseo 炭黑深色与 Paseo 浅色黑白单色主操作体系
export const BUILTIN_THEMES: CustomTheme[] = [
  { name: "Paseo 暗黑（默认）", colors: { ink: "#f4f4f5", paper: "#0d0d10", surface: "#111115", line: "#202027", lineStrong: "#2d2d37", accent: "#f4f4f5", accentDeep: "#ffffff", accentSoft: "#27272f" } },
  { name: "Paseo 浅色", colors: { ink: "#09090b", paper: "#f4f5f7", surface: "#ffffff", line: "#e4e5ea", lineStrong: "#cfd2dc", accent: "#18181b", accentDeep: "#09090b", accentSoft: "#e4e5ea" } },
  { name: "汇流蓝", colors: { ink: "#111827", paper: "#f7f8fa", surface: "#ffffff", line: "#e6e8ee", lineStrong: "#cdd2df", accent: "#4353ff", accentDeep: "#3341e0", accentSoft: "#eef0ff" } },
  { name: "海洋深处", colors: { ink: "#0f2440", paper: "#eef4f8", surface: "#ffffff", line: "#d8e3ec", lineStrong: "#b9cbdc", accent: "#0e7490", accentDeep: "#0b5a6e", accentSoft: "#e0f2f7" } },
  { name: "森林树冠", colors: { ink: "#1d2a20", paper: "#f1f6f1", surface: "#ffffff", line: "#dce7dc", lineStrong: "#b9cdb9", accent: "#2f6b4f", accentDeep: "#24523c", accentSoft: "#e3f0e6" } },
  { name: "指挥台深色", colors: { ink: "#f1f5f9", paper: "#0e1015", surface: "#171a23", line: "#232836", lineStrong: "#323a4e", accent: "#10b981", accentDeep: "#059669", accentSoft: "#10362c" } },
  { name: "终端蓝黑", colors: { ink: "#eceff5", paper: "#0b0d12", surface: "#12151e", line: "#1f2432", lineStrong: "#2f374a", accent: "#7e8cff", accentDeep: "#6978ff", accentSoft: "#1b203a" } },
];

/** 纸面色亮度判定：paper 偏暗即视为深色主题（决定 data-theme 联动） */
function isDarkPaper(colors: ThemeColors): boolean {
  const channels = hexToChannels(colors.paper);
  if (!channels) return false;
  const [r, g, b] = channels.split(" ").map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

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
  try {
    storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify([...rest, theme]));
  } catch {
    /* quota exceeded or private mode */
  }
}

export function deleteCustomTheme(name: string, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(listCustomThemes(storage).filter((t) => t.name !== name)));
  } catch {
    /* storage unavailable */
  }
}

export function getActiveCustomThemeName(storage: Storage = window.localStorage): string | null {
  try {
    return storage.getItem(ACTIVE_CUSTOM_THEME_KEY);
  } catch {
    return null;
  }
}

/** 激活某个主题（写偏好并立即应用）；null 回到默认汇流蓝。
 *  深色色板会联动 data-theme（原生控件 color-scheme 跟随）。 */
export function setActiveCustomTheme(name: string | null, storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  if (name !== null) {
    const theme = listCustomThemes(storage).find((t) => t.name === name) ?? BUILTIN_THEMES.find((t) => t.name === name);
    if (!theme) return;
    try {
      storage.setItem(ACTIVE_CUSTOM_THEME_KEY, name);
    } catch {
      /* still apply in-memory for this session */
    }
    const mode = isDarkPaper(theme.colors) ? "dark" : "light";
    root.dataset.theme = mode;
    syncNativeChrome(mode);
    applyThemeColors(root, theme.colors);
    return;
  }
  try {
    storage.removeItem(ACTIVE_CUSTOM_THEME_KEY);
  } catch {
    /* ignore */
  }
  refreshTokenApplication(storage, root);
}

/** 启动时恢复上次激活的自定义主题（无则保持 :root 默认） */
export function applySavedCustomTheme(storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  refreshTokenApplication(storage, root);
}

/**
 * 令牌应用的唯一入口：色板是明暗的唯一真相源。
 * - 激活深色色板 → 内联令牌 + data-theme=dark（原生控件跟随）
 * - 激活浅色色板 → 内联令牌 + data-theme=light
 * - 无激活色板 → 清内联走默认浅色；旧 conflux.theme 偏好不再读取
 */
export function refreshTokenApplication(storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  const name = getActiveCustomThemeName(storage);
  const theme = name === null || name === BUILTIN_THEMES[0].name
    ? null
    : listCustomThemes(storage).find((t) => t.name === name) ?? BUILTIN_THEMES.find((t) => t.name === name) ?? null;
  if (theme) {
    const mode = isDarkPaper(theme.colors) ? "dark" : "light";
    root.dataset.theme = mode;
    syncNativeChrome(mode);
    applyThemeColors(root, theme.colors);
    return;
  }
  root.dataset.theme = "dark";
  syncNativeChrome("dark");
  applyThemeColors(root, null);
}
