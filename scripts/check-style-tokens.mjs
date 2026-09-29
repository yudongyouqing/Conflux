#!/usr/bin/env node
/**
 * Style-token floor guard (#109): arbitrary font sizes below the 11px
 * ladder floor and inline font-size declarations are rejected. Grows into a
 * full token linter; start narrow so legacy code passes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "apps/web/src");
const violations = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(name)) {
      const text = readFileSync(p, "utf8");
      const rel = p.slice(ROOT.length);
      for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(m[1]) < 11) violations.push(`${rel}: text-[${m[1]}px] below the 11px floor — use text-2xs`);
      }
      for (const m of text.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
        if (Number(m[1]) < 11) violations.push(`${rel}: inline font-size ${m[1]}px below floor`);
      }
    }
  }
}
walk(SRC);

if (violations.length) {
  console.error(`check-style-tokens: ${violations.length} violation(s)`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("check-style-tokens: clean");
