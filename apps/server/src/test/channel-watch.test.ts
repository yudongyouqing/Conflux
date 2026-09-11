import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseEdgeId,
  parseWatchInterval,
  watchChannelSnapshots,
  type ChannelSnapshot,
} from "../cli/channel-watch.js";

function snapshot(question: string, reply: string | null = null): ChannelSnapshot {
  return {
    edge: { id: 1, from: "from", to: "to" },
    messages: [
      {
        id: 1,
        edge_id: 1,
        from_session: "from",
        to_session: "to",
        question,
        reply,
        status: reply ? "replied" : "pending",
        created_at: "2026-09-11T00:00:00.000Z",
        replied_at: reply ? "2026-09-11T00:00:01.000Z" : null,
      },
    ],
  };
}

async function collectSnapshots(snapshots: ChannelSnapshot[]): Promise<ChannelSnapshot[]> {
  const controller = new AbortController();
  let reads = 0;
  const observed: ChannelSnapshot[] = [];
  const read = async () => snapshots[Math.min(reads++, snapshots.length - 1)]!;
  const wait = async () => {
    if (reads >= snapshots.length) controller.abort();
  };

  for await (const current of watchChannelSnapshots(read, {
    intervalMs: 1,
    signal: controller.signal,
    wait,
  })) {
    observed.push(current);
  }

  return observed;
}

test("watch emits the initial snapshot and ignores an unchanged poll", async () => {
  const observed = await collectSnapshots([snapshot("first"), snapshot("first")]);

  assert.deepEqual(
    observed.map((current) => current.messages[0]!.question),
    ["first"],
  );
});

test("watch emits when an existing message gains a reply", async () => {
  const observed = await collectSnapshots([snapshot("question"), snapshot("question", "answer")]);

  assert.deepEqual(
    observed.map((current) => current.messages[0]!.reply),
    [null, "answer"],
  );
});

test("watch yields nothing when cancelled before the first read", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;

  const observed: ChannelSnapshot[] = [];
  for await (const current of watchChannelSnapshots(
    async () => {
      reads += 1;
      return snapshot("never");
    },
    { intervalMs: 1, signal: controller.signal },
  )) {
    observed.push(current);
  }

  assert.equal(reads, 0);
  assert.deepEqual(observed, []);
});

test("parseEdgeId accepts positive integers and rejects invalid values", () => {
  assert.equal(parseEdgeId("26"), 26);
  assert.throws(() => parseEdgeId("0"), /positive integer/);
  assert.throws(() => parseEdgeId("1.5"), /positive integer/);
  assert.throws(() => parseEdgeId("not-an-id"), /positive integer/);
});

test("parseWatchInterval defaults to one second and rejects invalid values", () => {
  assert.equal(parseWatchInterval(undefined), 1000);
  assert.equal(parseWatchInterval("250"), 250);
  assert.throws(() => parseWatchInterval("0"), /positive integer/);
  assert.throws(() => parseWatchInterval("250.5"), /positive integer/);
  assert.throws(() => parseWatchInterval("invalid"), /positive integer/);
});
