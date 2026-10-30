const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { waitMessage } = require("./server-database.cjs");

function childStub() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
}

test("IPC waits fail on early exit and clean up all listeners", async () => {
  const child = childStub();
  const pending = waitMessage(child, null, (m) => m.ready);
  child.emit("exit", 7, null);
  await assert.rejects(pending, /code=7/);
  assert.equal(child.eventNames().length, 0);
});

test("IPC waits ignore unrelated replies, propagate errors and enforce deadlines", async () => {
  const child = childStub();
  const pending = waitMessage(child, null, (m) => m.id === 2);
  child.emit("message", { id: 1 });
  child.emit("message", { id: 2, error: "worker error" });
  await assert.rejects(pending, /worker error/);
  await assert.rejects(
    waitMessage(child, null, () => true, 10),
    /deadline/,
  );
  assert.equal(child.eventNames().length, 0);
});
