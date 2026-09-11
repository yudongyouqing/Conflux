import type { Message } from "@muiltchat/shared";

export interface ChannelSnapshot {
  edge: { id: number; from: string; to: string };
  messages: Message[];
}

export type ChannelSnapshotReader = () => Promise<ChannelSnapshot>;
export type ChannelWatchWait = (intervalMs: number, signal?: AbortSignal) => Promise<void>;

export function parseEdgeId(raw: string): number {
  const edgeId = Number(raw);
  if (!Number.isSafeInteger(edgeId) || edgeId < 1) {
    throw new Error("edge id must be a positive integer");
  }
  return edgeId;
}

export function parseWatchInterval(raw: string | undefined): number {
  if (raw === undefined) return 1000;
  const intervalMs = Number(raw);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("interval must be a positive integer in milliseconds");
  }
  return intervalMs;
}

export async function* watchChannelSnapshots(
  read: ChannelSnapshotReader,
  options: {
    intervalMs: number;
    signal?: AbortSignal;
    wait?: ChannelWatchWait;
  },
): AsyncGenerator<ChannelSnapshot> {
  const wait = options.wait ?? waitForNextPoll;
  let previous: string | undefined;

  while (!options.signal?.aborted) {
    const snapshot = await read();
    if (options.signal?.aborted) return;

    const fingerprint = snapshotFingerprint(snapshot);
    if (fingerprint !== previous) {
      previous = fingerprint;
      yield snapshot;
    }

    if (options.signal?.aborted) return;
    await wait(options.intervalMs, options.signal);
  }
}

function snapshotFingerprint(snapshot: ChannelSnapshot): string {
  return JSON.stringify([
    snapshot.edge.id,
    snapshot.edge.from,
    snapshot.edge.to,
    snapshot.messages.map((message) => [
      message.id,
      message.status,
      message.question,
      message.reply,
      message.replied_at,
    ]),
  ]);
}

function waitForNextPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, intervalMs);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
