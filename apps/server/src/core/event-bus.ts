import type { LiveEventEnvelope, LiveEventType } from "@conflux/shared";
import { nowIso } from "./db.js";

export interface LiveEventFilter {
  project_id?: number;
  thread_id?: string;
  room_id?: number;
  workflow_run_id?: number;
}

type LiveListener = (event: LiveEventEnvelope) => void;

const RING_BUFFER_LIMIT = 800;

let nextEventId = 0;
const ringBuffer: LiveEventEnvelope[] = [];
const listeners = new Set<{ fn: LiveListener; filter?: LiveEventFilter }>();

function matchesFilter(ev: LiveEventEnvelope, filter?: LiveEventFilter): boolean {
  if (!filter) return true;
  if (filter.project_id !== undefined && ev.project_id !== filter.project_id) return false;
  if (filter.thread_id !== undefined && ev.thread_id !== filter.thread_id) return false;
  if (filter.room_id !== undefined && ev.room_id !== filter.room_id) return false;
  if (filter.workflow_run_id !== undefined && ev.workflow_run_id !== filter.workflow_run_id)
    return false;
  return true;
}

export function publishLiveEvent(input: {
  type: LiveEventType;
  project_id?: number | null;
  thread_id?: string | null;
  room_id?: number | null;
  workflow_run_id?: number | null;
  payload: Record<string, unknown>;
}): LiveEventEnvelope {
  const envelope: LiveEventEnvelope = {
    id: ++nextEventId,
    type: input.type,
    ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
    ...(input.thread_id !== undefined ? { thread_id: input.thread_id } : {}),
    ...(input.room_id !== undefined ? { room_id: input.room_id } : {}),
    ...(input.workflow_run_id !== undefined ? { workflow_run_id: input.workflow_run_id } : {}),
    payload: input.payload,
    created_at: nowIso(),
  };

  ringBuffer.push(envelope);
  if (ringBuffer.length > RING_BUFFER_LIMIT) {
    ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_LIMIT);
  }

  for (const entry of listeners) {
    if (!matchesFilter(envelope, entry.filter)) continue;
    try {
      entry.fn(envelope);
    } catch {
      // isolate listener failures
    }
  }
  return envelope;
}

export function replayLiveEventsAfter(
  afterId: number,
  filter?: LiveEventFilter,
): LiveEventEnvelope[] {
  return ringBuffer.filter((ev) => ev.id > afterId && matchesFilter(ev, filter));
}

export function subscribeLiveEvents(
  fn: LiveListener,
  filter?: LiveEventFilter,
): () => void {
  const entry = { fn, filter };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

export function resetLiveEventBusForTest(): void {
  ringBuffer.length = 0;
  listeners.clear();
  nextEventId = 0;
}
