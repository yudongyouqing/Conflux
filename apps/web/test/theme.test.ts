import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeThemePreference, resolveTheme } from "../src/theme.ts";

test("theme preference normalizes invalid values and resolves system", () => {
  assert.equal(normalizeThemePreference("terminal"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});
