const { test } = require("node:test");
const assert = require("node:assert/strict");
const { waitForPtyEcho } = require("./packaged-module-smoke.cjs");

function fixture() {
  let data, exit;
  let kills = 0;
  const child = {
    onData(fn) { data = fn; return { dispose() {} }; },
    onExit(fn) { exit = fn; return { dispose() {} }; },
    kill() { kills++; exit({ exitCode: 1 }); },
  };
  return { child, data: (text) => data(text), exit: (code) => exit({ exitCode: code }), kills: () => kills };
}

test("echo alone does not pass until the PTY has exited", async () => {
  const f = fixture();
  let finished = false;
  const result = waitForPtyEcho(f.child, { disposeOnExit: false }).then(() => { finished = true; });
  f.data("conflux-pty-smoke\r\n");
  await new Promise(setImmediate);
  assert.equal(finished, false);
  f.exit(0);
  await result;
  assert.equal(f.kills(), 0);
});

test("Windows exit releases the owned ConPTY after observing the shell exit", async () => {
  const f = fixture();
  const result = waitForPtyEcho(f.child, { disposeOnExit: true });
  f.data("conflux-pty-smoke");
  assert.equal(f.kills(), 0);
  f.exit(0);
  await result;
  assert.equal(f.kills(), 1);
});

test("failed exit and missing echo fail the smoke", async () => {
  for (const code of [0, 1]) {
    const f = fixture();
    const result = waitForPtyEcho(f.child);
    f.exit(code);
    await assert.rejects(result, /without successful echo/);
  }
});

test("a stalled probe terminates only its own PTY and reports failure", async () => {
  const f = fixture();
  const result = waitForPtyEcho(f.child, { timeoutMs: 20 });
  await assert.rejects(result, /timed out/);
  assert.equal(f.kills(), 1);
});
