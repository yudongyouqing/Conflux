import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManagedRpcConnection,
  RpcClosedError,
  RpcInFlightLimitError,
  RpcTimeoutError,
} from "../core/managed-codex/rpc.js";

// JSONL framing and request correlation over a fake byte transport: chunked
// lines, multi-line chunks, CRLF, out-of-order responses, unknown
// notifications, invalid JSON, timeouts, stream end — every pending promise
// must settle exactly once and a closed generation must never answer a new
// connection's requests.

interface Harness {
  conn: ManagedRpcConnection;
  sentFrames: string[];
  feed: (chunk: string) => void;
  endStream: () => void;
}

function makeConn(
  handlers: {
    onNotification?: (method: string, params: unknown) => void;
    onServerRequest?: (id: number | string, method: string, params: unknown) => void;
    onProtocolError?: (message: string) => void;
  } = {},
  opts: { requestTimeoutMs?: number; maxInFlight?: number; maxFrameBytes?: number } = {},
): Harness {
  const sentFrames: string[] = [];
  const conn = new ManagedRpcConnection(
    {
      write: (frame) => sentFrames.push(frame),
      close: () => {},
    },
    handlers,
    opts,
  );
  return {
    conn,
    sentFrames,
    feed: (chunk) => conn.handleChunk(chunk),
    endStream: () => conn.handleEnd(),
  };
}

function frame(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

test("a frame split across many chunks resolves its request", async () => {
  const h = makeConn();
  const promise = h.conn.request("initialize", { a: 1 });
  const raw = frame(1, { userAgent: "x" });
  const third = Math.ceil(raw.length / 3);
  h.feed(raw.slice(0, third));
  h.feed(raw.slice(third, 2 * third));
  h.feed(raw.slice(2 * third));
  assert.deepEqual(await promise, { userAgent: "x" });
});

test("multiple frames in one chunk are all dispatched", async () => {
  const notifications: string[] = [];
  const h = makeConn({ onNotification: (m) => notifications.push(m) });
  const a = h.conn.request("a");
  const b = h.conn.request("b");
  h.feed(frame(2, "second") + frame(1, "first"));
  assert.equal(await a, "first");
  assert.equal(await b, "second");
  h.feed(
    JSON.stringify({ jsonrpc: "2.0", method: "n1" }) +
      "\r\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "n2" }) +
      "\r\n",
  );
  assert.deepEqual(notifications, ["n1", "n2"]);
});

test("CRLF line endings are stripped before parsing", async () => {
  const h = makeConn();
  const promise = h.conn.request("x");
  h.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }) + "\r\n");
  assert.equal(await promise, 42);
});

test("out-of-order responses resolve the right requests", async () => {
  const h = makeConn();
  const first = h.conn.request("one");
  const second = h.conn.request("two");
  h.feed(frame(2, "resp-two") + frame(1, "resp-one"));
  assert.equal(await first, "resp-one");
  assert.equal(await second, "resp-two");
});

test("request ids are monotonically increasing per connection", async () => {
  const h = makeConn();
  const p1 = h.conn.request("m");
  const p2 = h.conn.request("m");
  const ids = h.sentFrames.map((f) => (JSON.parse(f) as { id: number }).id);
  assert.deepEqual(ids, [1, 2]);
  h.feed(frame(1, null) + frame(2, null));
  await Promise.all([p1, p2]);
});

test("unknown notifications are surfaced, not fatal", async () => {
  const seen: string[] = [];
  const h = makeConn({ onNotification: (m) => seen.push(m) });
  const promise = h.conn.request("m");
  h.feed(
    JSON.stringify({ jsonrpc: "2.0", method: "some/future/notification", params: { z: 1 } }) +
      "\n",
  );
  h.feed(frame(1, "ok"));
  assert.equal(await promise, "ok");
  assert.deepEqual(seen, ["some/future/notification"]);
});

test("invalid JSON on a line reports a protocol error and the connection continues", async () => {
  const errors: string[] = [];
  const h = makeConn({ onProtocolError: (m) => errors.push(m) });
  const promise = h.conn.request("m");
  h.feed("this is not json\n");
  h.feed(frame(1, "still fine"));
  assert.equal(await promise, "still fine");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /invalid JSON/);
});

test("invalid frame shape reports a protocol error without throwing", () => {
  const errors: string[] = [];
  const h = makeConn({ onProtocolError: (m) => errors.push(m) });
  h.feed("[1,2,3]\n"); // not a JSON-RPC object
  h.feed(JSON.stringify({ jsonrpc: "2.0" }) + "\n"); // neither request nor response
  assert.equal(errors.length, 2);
});

test("error responses reject the request with the remote error", async () => {
  const h = makeConn();
  const promise = h.conn.request("boom");
  h.feed(
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }) +
      "\n",
  );
  await assert.rejects(promise, /bad params/);
});

test("requests time out and a late response is ignored", async () => {
  const h = makeConn({ onProtocolError: () => {} }, { requestTimeoutMs: 30 });
  const promise = h.conn.request("slow");
  await assert.rejects(promise, RpcTimeoutError);
  // The late frame must not crash or produce an unhandled rejection.
  h.feed(frame(1, { late: true }));
  // And the id slot is free again: a new request reuses a fresh id.
  const next = h.conn.request("again", undefined, { timeoutMs: 500 });
  h.feed(frame(2, "ok"));
  assert.equal(await next, "ok");
});

test("an abort signal cancels the wait without rejecting late", async () => {
  const h = makeConn();
  const controller = new AbortController();
  const promise = h.conn.request("cancellable", undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, /abort/i);
  h.feed(frame(1, "late"));
});

test("stream end rejects all pending requests exactly once", async () => {
  const h = makeConn();
  const a = h.conn.request("a");
  const b = h.conn.request("b");
  h.endStream();
  await assert.rejects(a, RpcClosedError);
  await assert.rejects(b, RpcClosedError);
  // Settled promises stay settled: closing again must not throw.
  h.endStream();
});

test("close() rejects pending requests and is idempotent", async () => {
  const h = makeConn();
  const promise = h.conn.request("x");
  h.conn.close(new Error("shutting down"));
  await assert.rejects(promise, /shutting down/);
  h.conn.close();
});

test("requests after close fail immediately", async () => {
  const h = makeConn();
  h.conn.close();
  await assert.rejects(h.conn.request("late"), RpcClosedError);
});

test("frames above the size cap fail the connection", async () => {
  const h = makeConn({}, { maxFrameBytes: 64 });
  const promise = h.conn.request("x");
  const huge = "x".repeat(200);
  h.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: huge }) + "\n");
  await assert.rejects(promise, /frame/i);
});

test("the in-flight cap rejects excess requests up front", async () => {
  const h = makeConn({}, { maxInFlight: 2 });
  const a = h.conn.request("a", undefined, { timeoutMs: 5000 });
  const b = h.conn.request("b", undefined, { timeoutMs: 5000 });
  await assert.rejects(h.conn.request("c"), RpcInFlightLimitError);
  h.feed(frame(1, null) + frame(2, null));
  await Promise.all([a, b]);
});

test("server requests are dispatched with their own id and answered via respond()", () => {
  const requests: Array<{ id: number | string; method: string }> = [];
  const h = makeConn({
    onServerRequest: (id, method) => requests.push({ id, method }),
  });
  h.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9001,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t" },
    }) + "\n",
  );
  assert.deepEqual(requests, [{ id: 9001, method: "item/commandExecution/requestApproval" }]);
  h.conn.respond(9001, { decision: "accept" });
  const sent = JSON.parse(h.sentFrames[0]) as { id: number; result: { decision: string } };
  assert.equal(sent.id, 9001);
  assert.deepEqual(sent.result, { decision: "accept" });
});

test("a late frame on a closed connection never settles a new connection's request", async () => {
  const oldConn = makeConn();
  const stale = oldConn.conn.request("old");
  oldConn.conn.close();
  await assert.rejects(stale, RpcClosedError);

  const fresh = makeConn();
  const freshPromise = fresh.conn.request("new", undefined, { timeoutMs: 120 });
  // The stale stream's leftover bytes arrive AFTER the new connection was
  // built; they are fed to the old (closed) connection, not the new one.
  oldConn.feed(frame(1, "ghost"));
  await assert.rejects(freshPromise, RpcTimeoutError);
  assert.notEqual(oldConn.conn.generation, fresh.conn.generation);
});
