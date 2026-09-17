import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../src/components/MarkdownText.tsx";

test("fenced code blocks get highlight.js tokens and a language marker", () => {
  const md = "```ts\nconst answer: number = 42;\n```";
  const html = renderToStaticMarkup(createElement(MarkdownText, { children: md }));
  assert.match(html, /language-ts/, "fence language preserved on the code element");
  assert.match(html, /hljs-keyword/, "keywords highlighted (const)");
  assert.match(html, /hljs-number/, "numbers highlighted (42)");
});

test("fenced blocks without a language render as plain blocks, not inline pink", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownText, { children: "```\nplain text\n```" }),
  );
  assert.doesNotMatch(html, /language-/);
  assert.doesNotMatch(html, /text-pink-600/, "no inline-code styling inside pre");
  assert.match(html, /<pre/, "stays inside a pre block");
});

test("inline code stays plain (no hljs tokens)", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownText, { children: "run `const x = 1` now" }),
  );
  assert.match(html, /<code /);
  assert.doesNotMatch(html, /hljs-/);
});
