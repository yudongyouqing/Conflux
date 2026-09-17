import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineMarkdown } from "../src/components/InlineMarkdown.tsx";

const render = (s: string) => renderToStaticMarkup(createElement(InlineMarkdown, null, s));

test("bold, italic, strikethrough render as styled inline elements", () => {
  const html = render("**重点** 和 *次要* 以及 ~~作废~~");
  assert.match(html, /<strong class="[^"]*font-semibold/);
  assert.match(html, /<em /);
  assert.match(html, /line-through/);
  assert.match(html, /重点/);
});

test("code spans render pink mono and protect inner markers", () => {
  const html = render("run `npm test **now**` please");
  assert.match(html, /<code class="[^"]*text-pink-600/);
  assert.match(html, /npm test \*\*now\*\*/);
  assert.doesNotMatch(html, /<strong/);
});

test("markdown links render as anchors with safe attrs", () => {
  const html = render("see [docs](https://example.com/a) here");
  assert.match(html, /<a href="https:\/\/example.com\/a" target="_blank" rel="noreferrer"/);
  assert.match(html, />docs<\/a>/);
});

test("unclosed markers stay literal", () => {
  const html = render("count **two and `one");
  assert.match(html, /\*\*two/);
  assert.match(html, /`one/);
  assert.doesNotMatch(html, /<strong/);
});

test("plain text passes through untouched", () => {
  assert.match(render("普通的中文预览 123"), /<span>普通的中文预览 123<\/span>/);
});
