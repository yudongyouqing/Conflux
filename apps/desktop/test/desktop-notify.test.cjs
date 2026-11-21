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
  assert.match(out[2].title, /bbb 回复了 ccc/);
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
  let poll;
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
    immediate: false,
    onNotify: (n) => seen.push(n),
    setIntervalFn: (callback) => {
      poll = callback;
      return 1;
    },
    clearIntervalFn: () => {},
  });

  await poll();
  await poll();
  await poll();
  stop();
  assert.deepEqual(
    seen.map((n) => n.id),
    [10],
    "boot 静默 + 只通知新消息",
  );
});

test("runner polls immediately on startup with limit=100 to establish watermark", async () => {
  const urls = [];
  const seen = [];
  let poll;
  const fetchFn = async (url) => {
    urls.push(url);
    if (urls.length === 1) {
      return { ok: true, json: async () => ({ messages: [{ id: 4, from_session: "a", to_session: "b", question: "old", reply: null }] }) };
    }
    return { ok: true, json: async () => ({ messages: [{ id: 5, from_session: "a", to_session: "b", question: "new", reply: null }] }) };
  };
  const stop = startMessageNotifications({
    baseUrl: "http://x",
    fetchFn,
    onNotify: (n) => seen.push(n),
    setIntervalFn: (cb) => { poll = cb; return 1; },
    clearIntervalFn: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, ["http://x/messages?limit=100"]);
  assert.deepEqual(seen, [], "initial immediate poll is silent watermark");
  await poll();
  stop();
  assert.deepEqual(seen.map((n) => n.id), [5]);
});


test("runner notifies once when a previously seen question receives a reply", async () => {
  let poll;
  let messages = [{ id: 9, from_name: "Asker", to_name: "Replier", question: "q", reply: null }];
  const notifications = [];
  const stop = startMessageNotifications({ baseUrl: "http://x", immediate: false, fetchFn: async () => ({ ok: true, json: async () => ({ messages }) }), onNotify: n => notifications.push(n), setIntervalFn: cb => { poll = cb; return 1; }, clearIntervalFn: () => {} });
  await poll();
  messages = [{ ...messages[0], reply: "answer", replied_at: "2026-11-18T00:00:00Z" }];
  await poll(); await poll(); stop();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Replier 回复了 Asker");
});

test("runner does not notify if stopped during an in-flight request", async () => {
  let poll; let finish; let calls = 0;
  const notifications = [];
  const stop = startMessageNotifications({ baseUrl: "http://x", immediate: false, fetchFn: async () => ({ ok: true, json: async () => ++calls === 1 ? { messages: [] } : new Promise(r => { finish = r; }) }), onNotify: n => notifications.push(n), setIntervalFn: cb => { poll = cb; return 1; }, clearIntervalFn: () => {} });
  await poll(); const pending = poll(); await new Promise(r => setImmediate(r)); stop();
  finish({ messages: [{ id: 1, question: "q" }] }); await pending;
  assert.equal(notifications.length, 0);
});

test("runner times out a stalled response body so later polls recover", async () => {
  let poll;
  let requests = 0;
  let bodyReadStarted = false;
  let stalledSignal;
  let releaseBody;
  const notifications = [];
  const stop = startMessageNotifications({
    baseUrl: "http://x",
    immediate: false,
    requestTimeoutMs: 40,
    fetchFn: async (_url, { signal }) => {
      requests++;
      if (requests === 1) {
        stalledSignal = signal;
        return {
          ok: true,
          json: () => {
            bodyReadStarted = true;
            return new Promise((resolve, reject) => {
              releaseBody = () => resolve({ messages: [] });
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        };
      }
      const id = requests - 1;
      return { ok: true, json: async () => ({ messages: [{ id, question: "q" }] }) };
    },
    onNotify: (notification) => notifications.push(notification.id),
    setIntervalFn: cb => { poll = cb; return 1; },
    clearIntervalFn: () => {},
  });
  let pending;
  let guard;
  try {
    pending = poll();
    const completed = await Promise.race([
      pending.then(() => true),
      new Promise(resolve => { guard = setTimeout(() => resolve(false), 1000); }),
    ]);
    assert.equal(completed, true, "a stalled body must release the polling lock");
    assert.equal(bodyReadStarted, true);
    assert.equal(stalledSignal.aborted, true);
    await poll();
    assert.deepEqual(notifications, []);
    await poll();
    assert.deepEqual(notifications, [2]);
  } finally {
    clearTimeout(guard);
    stop();
    releaseBody?.();
    await pending;
  }
});

test("stopping notifications aborts the active request", async () => {
  let poll;
  let signal;
  let finish;
  const stop = startMessageNotifications({
    baseUrl: "http://x",
    immediate: false,
    fetchFn: async (_url, options) => {
      signal = options?.signal;
      return new Promise(resolve => {
        finish = () => resolve({ ok: false });
        signal?.addEventListener("abort", finish, { once: true });
      });
    },
    onNotify: () => assert.fail("stopped requests must not notify"),
    setIntervalFn: cb => { poll = cb; return 1; },
    clearIntervalFn: () => {},
  });
  const pending = poll();
  try {
    stop();
    assert.equal(signal?.aborted, true);
  } finally {
    finish();
    await pending;
  }
});
