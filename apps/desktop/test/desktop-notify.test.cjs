const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  pickNotifications,
  startMessageNotifications,
  excerpt,
} = require("../src/desktop-notify.cjs");

test("pickNotifications: replies and questions past the watermark notify, in id order", () => {
  const out = pickNotifications(
    [
      { id: 7, from_session: "aaa", to_session: "bbb", reply: null, question: "新提问" },
      { id: 5, from_session: "aaa", to_session: "bbb", reply: "旧回复", question: "q" },
      { id: 8, from_session: "ccc", to_session: "bbb", reply: "新回复", question: "q" },
      { id: 6, from_session: "x", to_session: "y", reply: null, question: "另一问" },
    ],
    5,
  );
  assert.deepEqual(
    out.map((n) => n.id),
    [6, 7, 8],
  );
  assert.match(out[0].title, /x → y 提问/);
  assert.match(out[1].title, /aaa → bbb 提问/);
  assert.match(out[2].title, /ccc 回复了 bbb/);
  assert.equal(out[2].body, "新回复");
});

test("excerpt collapses whitespace and truncates at 80 chars", () => {
  assert.equal(excerpt("你好,\n   多行 内容"), "你好, 多行 内容");
  const long = excerpt("字".repeat(100));
  assert.equal(long.length, 81);
  assert.ok(long.endsWith("…"));
});

test("runner: first poll is silent (watermark), new ids notify once", async () => {
  const seen = [];
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1)
      return { ok: true, json: async () => ({ messages: [{ id: 9, from_session: "a", to_session: "b", question: "存量", reply: null }] }) };
    if (call === 2)
      return { ok: true, json: async () => ({ messages: [{ id: 10, from_session: "a", to_session: "b", question: "新的", reply: null }] }) };
    return { ok: true, json: async () => ({ messages: [] }) };
  };
  const stop = startMessageNotifications({
    baseUrl: "http://x",
    fetchFn,
    intervalMs: 5,
    onNotify: (n) => seen.push(n),
  });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.deepEqual(
    seen.map((n) => n.id),
    [10],
    "boot 静默 + 只通知新消息",
  );
});
