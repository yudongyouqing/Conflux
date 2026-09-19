import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hexToChannels,
  normalizeThemeColors,
  applyThemeColors,
  listCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  setActiveCustomTheme,
  BUILTIN_THEMES,
} from "../src/theme.ts";

test("theme preference normalizes invalid values and resolves system", () => {
  assert.equal(normalizeThemePreference("terminal"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

// ---- 自定义主题（#71） ------------------------------------------------------

import { normalizeThemePreference, resolveTheme } from "../src/theme.ts";

/** 内存版 Storage，模拟 localStorage 接口 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getLength: () => map.size,
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  } as Storage;
}

test("hexToChannels converts hex to rgb channel triplet, rejects bad input", () => {
  assert.equal(hexToChannels("#2563eb"), "37 99 235");
  assert.equal(hexToChannels("#FFF"), null, "3 位缩写不支持——导入规格要求 6 位");
  assert.equal(hexToChannels("nope"), null);
});

test("normalizeThemeColors requires all 10 keys as 6-digit hex", () => {
  const good = BUILTIN_THEMES[0].colors;
  assert.deepEqual(normalizeThemeColors(good), good);
  assert.equal(normalizeThemeColors({ ...good, accent: "#2 56" }), null, "非 hex 拒绝");
  const missing = { ...good } as Record<string, string>;
  delete missing.lineStrong;
  assert.equal(normalizeThemeColors(missing), null, "缺键拒绝");
  assert.equal(normalizeThemeColors("nope"), null);
});

test("applyThemeColors writes channel vars and null clears them", () => {
  const written = new Map<string, string>();
  const target = {
    style: {
      setProperty: (k: string, v: string) => void written.set(k, v),
      removeProperty: (k: string) => void written.delete(k),
    },
  };
  applyThemeColors(target, BUILTIN_THEMES[1].colors);
  assert.equal(written.get("--tk-accent"), "14 116 144", "海洋深处 accent #0e7490");
  assert.ok(written.get("--tk-paper"));
  applyThemeColors(target, null);
  assert.equal(written.size, 0, "null 清除全部覆盖");
});

test("custom theme registry: save/list/delete round-trips via storage", () => {
  const storage = fakeStorage();
  const theme = { name: "测试主题", colors: BUILTIN_THEMES[0].colors };
  saveCustomTheme(theme, storage);
  saveCustomTheme({ ...theme, name: "测试主题二" }, storage);
  // 同名覆盖而非重复
  saveCustomTheme(theme, storage);
  assert.deepEqual(listCustomThemes(storage).map((t) => t.name), ["测试主题二", "测试主题"]);
  deleteCustomTheme("测试主题二", storage);
  assert.deepEqual(listCustomThemes(storage).map((t) => t.name), ["测试主题"]);
  // 坏数据被静默剔除
  storage.setItem("conflux.custom-themes", '[{"name":"坏的","colors":{"ink":"xx"}}]');
  assert.equal(listCustomThemes(storage).length, 0);
});

test("setActiveCustomTheme persists the name; null clears", () => {
  const storage = fakeStorage();
  setActiveCustomTheme("海洋深处", storage, fakeStyleRecorder());
  assert.equal(storage.getItem("conflux.active-custom-theme"), "海洋深处");
  setActiveCustomTheme(null, storage, fakeStyleRecorder());
  assert.equal(storage.getItem("conflux.active-custom-theme"), null);
});

function fakeStyleRecorder() {
  return { style: { setProperty: () => {}, removeProperty: () => {} } };
}
