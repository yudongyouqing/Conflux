const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererWatchdog } = require("../src/renderer-watchdog.cjs");

function fakeClock() {
  let current = 1_000;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

function fakeTimer() {
  let callback;
  let cleared = false;
  return {
    setIntervalFn: (fn) => {
      callback = fn;
      return { unref() {} };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    run: () => callback?.(),
    wasCleared: () => cleared,
  };
}

test("start sends a nonce ping and a valid pong marks the renderer responsive", () => {
  const clock = fakeClock();
  const timer = fakeTimer();
  const pings = [];
  const states = [];
  const watchdog = createRendererWatchdog({
    intervalMs: 10,
    timeoutMs: 30,
    now: clock.now,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    sendPing: (ping) => pings.push(ping),
    onStateChange: (snapshot) => states.push(snapshot),
  });

  watchdog.start();

  assert.equal(pings.length, 1);
  assert.equal(pings[0].nonce, 1);
  assert.equal(typeof pings[0].sentAt, "number");
  assert.equal(watchdog.handlePong({ nonce: 1 }), true);
  assert.equal(watchdog.snapshot().state, "responsive");
  assert.equal(states.at(-1).state, "responsive");
});

test("missing pong transitions to unknown after the timeout", () => {
  const clock = fakeClock();
  const timer = fakeTimer();
  const states = [];
  const watchdog = createRendererWatchdog({
    intervalMs: 10,
    timeoutMs: 30,
    now: clock.now,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    sendPing: () => {},
    onStateChange: (snapshot) => states.push(snapshot),
  });

  watchdog.start();
  clock.advance(31);
  timer.run();

  assert.equal(watchdog.snapshot().state, "unknown");
  assert.equal(states.at(-1).reason, "pong-timeout");
});

test("a pong after timeout recovers the renderer to responsive", () => {
  const clock = fakeClock();
  const timer = fakeTimer();
  const pings = [];
  const watchdog = createRendererWatchdog({
    intervalMs: 10,
    timeoutMs: 30,
    now: clock.now,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    sendPing: (ping) => pings.push(ping),
    onStateChange: () => {},
  });

  watchdog.start();
  clock.advance(31);
  timer.run();
  assert.equal(watchdog.snapshot().state, "unknown");

  assert.equal(watchdog.handlePong({ nonce: pings.at(-1).nonce }), true);
  assert.equal(watchdog.snapshot().state, "responsive");
});

test("unresponsive is recoverable while render-process-gone is crashed", () => {
  const watchdog = createRendererWatchdog({
    sendPing: () => {},
    onStateChange: () => {},
  });

  watchdog.start();
  watchdog.markUnresponsive({ reason: "event" });
  assert.equal(watchdog.snapshot().state, "unknown");
  watchdog.markResponsive();
  assert.equal(watchdog.snapshot().state, "responsive");
  watchdog.markCrashed({ reason: "crashed", exitCode: 1 });
  assert.equal(watchdog.snapshot().state, "crashed");
});

test("stop clears the timer and ignores later pong messages", () => {
  const clock = fakeClock();
  const timer = fakeTimer();
  const watchdog = createRendererWatchdog({
    now: clock.now,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    sendPing: () => {},
    onStateChange: () => {},
  });

  watchdog.start();
  watchdog.stop();

  assert.equal(timer.wasCleared(), true);
  assert.equal(watchdog.snapshot().state, "stopped");
  assert.equal(watchdog.handlePong({ nonce: 1 }), false);
});

