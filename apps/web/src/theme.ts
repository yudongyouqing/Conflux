/** 可注入的主题根：真实 HTMLElement 或测试用的结构化替身 */
type ThemeRoot = { dataset: Record<string, string | undefined>; style: { setProperty(key: string, value: string): void; removeProperty(key: string): void } };
/** 深浅同步到 Electron 原生控件（macOS 菜单栏/右键菜单跟随应用主题而非 OS 外观）；
 *  纯浏览器环境没有该桥，静默跳过 */
function syncNativeChrome(mode: "dark" | "light"): void {
  const bridge = (globalThis as { confluxDesktop?: { setNativeTheme?: (mode: string) => void } })
    .confluxDesktop;
  bridge?.setNativeTheme?.(mode);
}

/** 启动即按激活色板落令牌（bootstrap 随后会再走一次 refresh，幂等）。
 *  旧 system/light/dark 偏好与媒体查询监听随三段钮一起移除（#95）。 */
export function installTheme(win: Window = window): () => void { refreshTokenApplication(win.localStorage, win.document.documentElement); return () => {}; }

// ---- 自定义主题（#71）：令牌色板可导入/可切换 ------------------------------

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
}

// 内置预设：浅色系转译自 theme-factory 主题规格（Ocean Depths / Forest Canopy / Desert Rose / Tech Innovation），
// 终端深色 = 暗色令牌组的色板化（选中即全站深色）
export const BUILTIN_THEMES: CustomTheme[] = [
  { name: "汇流蓝（默认）", colors: { ink: "#182234", paper: "#f6f7f9", surface: "#ffffff", line: "#e4e8ef", lineStrong: "#cbd3e0", accent: "#2563eb", accentDeep: "#1e4fc4", accentSoft: "#ebf1fe" } },
  { name: "海洋深处", colors: { ink: "#0f2440", paper: "#eef4f8", surface: "#ffffff", line: "#d8e3ec", lineStrong: "#b9cbdc", accent: "#0e7490", accentDeep: "#0b5a6e", accentSoft: "#e0f2f7" } },
  { name: "森林树冠", colors: { ink: "#1d2a20", paper: "#f1f6f1", surface: "#ffffff", line: "#dce7dc", lineStrong: "#b9cdb9", accent: "#2f6b4f", accentDeep: "#24523c", accentSoft: "#e3f0e6" } },
  { name: "沙漠玫瑰", colors: { ink: "#33272b", paper: "#faf4f1", surface: "#ffffff", line: "#ecdfda", lineStrong: "#d6bfb8", accent: "#b76e79", accentDeep: "#96545f", accentSoft: "#f7e8e6" } },
  { name: "科技创新", colors: { ink: "#1e1e1e", paper: "#f5f7fa", surface: "#ffffff", line: "#e2e8f0", lineStrong: "#c4cfda", accent: "#0066ff", accentDeep: "#0052cc", accentSoft: "#e5eeff" } },
  { name: "终端深色", colors: { ink: "#e6eaf2", paper: "#0d121c", surface: "#172030", line: "#2c384a", lineStrong: "#3e4c62", accent: "#60a5fa", accentDeep: "#3b82f6", accentSoft: "#1e3a5f" } },
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
  storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify([...rest, theme]));
}

export function deleteCustomTheme(name: string, storage: Storage = window.localStorage): void {
  storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(listCustomThemes(storage).filter((t) => t.name !== name)));
}

export function getActiveCustomThemeName(storage: Storage = window.localStorage): string | null {
  return storage.getItem(ACTIVE_CUSTOM_THEME_KEY);
}

/** 激活某个主题（写偏好并立即应用）；null 回到默认汇流蓝。
 *  深色色板会联动 data-theme（原生控件 color-scheme 跟随）。 */
export function setActiveCustomTheme(name: string | null, storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  if (name !== null) {
    const theme = listCustomThemes(storage).find((t) => t.name === name) ?? BUILTIN_THEMES.find((t) => t.name === name);
    if (!theme) return;
    storage.setItem(ACTIVE_CUSTOM_THEME_KEY, name);
    const mode = isDarkPaper(theme.colors) ? "dark" : "light";
    root.dataset.theme = mode;
    syncNativeChrome(mode);
    applyThemeColors(root, theme.colors);
    return;
  }
  storage.removeItem(ACTIVE_CUSTOM_THEME_KEY);
  refreshTokenApplication(storage, root);
}

/** 启动时恢复上次激活的自定义主题（无则保持 :root 默认） */
export function applySavedCustomTheme(storage: Storage = window.localStorage, root: StyleTarget = document.documentElement): void {
  refreshTokenApplication(storage, root);
}

/**
 * 令牌应用的唯一入口：色板是明暗的唯一真相源（issue #95 起）。
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
  root.dataset.theme = "light";
  syncNativeChrome("light");
  applyThemeColors(root, null);
}
