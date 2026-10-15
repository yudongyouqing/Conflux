import { test } from "node:test";
import assert from "node:assert/strict";
import { badge, flattenOneLine, truncateForTyping } from "../core/inject-format.js";

test("badge renders mail provenance: kind ← from · ref", () => {
  assert.equal(
    badge({ label: "回复", from: "web-console", ref: "msg #42" }),
    "[Conflux·回复 ← web-console · msg #42]",
  );
  assert.equal(
    badge({ label: "提问", from: "agent-b", ref: "msg #7" }),
    "[Conflux·提问 ← agent-b · msg #7]",
  );
});

test("badge renders task/notice forms without from", () => {
  assert.equal(badge({ label: "聊天室任务", ref: "task #12" }), "[Conflux·聊天室任务 · task #12]");
  assert.equal(badge({ label: "任务完成通知" }), "[Conflux·任务完成通知]");
});

test("flattenOneLine collapses newlines and whitespace runs — typed text must be one line", () => {
  assert.equal(flattenOneLine("a\nb\r\n  c\t\td"), "a b c d");
  assert.equal(flattenOneLine("   "), "");
});

test("truncateForTyping keeps short text verbatim and caps long text with a hint", () => {
  assert.equal(truncateForTyping("short", 10, "channel show 1 看全文"), "short");
  const out = truncateForTyping("x".repeat(20), 10, "channel show 1 看全文");
  assert.equal(out, "x".repeat(10) + "…(截断，channel show 1 看全文)");
});
