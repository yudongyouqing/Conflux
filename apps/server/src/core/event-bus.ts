import type { LiveEventEnvelope, LiveEventType } from "@conflux/shared";
import { onManagedLiveEvent } from "./managed/executor.js";

/**
 * Process-wide live event bus with a bounded ring buffer for Last-Event-ID
 * replay on SSE reconnects. Drives real-time UI updates for managed streams,
 * approvals, room tasks/messages, shared memory, and workflow DAG progress.
 */

export interface LiveEventFilter {
  room_id?: number;
  session_id?: string;
  instance_id?: string;
  workflow_run_id?: number;
}

const MAX_BUFFER = 500;

let nextEventId = 1;
const ring: LiveEventEnvelope[] = [];
const listeners = new Set<(event: LiveEventEnvelope) => void>();
let managedBridgeInstalled = false;

function matchesFilter(event: LiveEventEnvelope, filter?: LiveEventFilter): boolean {
  if (!filter) return true;
  if (filter.room_id !== undefined && event.room_id !== filter.room_id) return false;
  if (filter.session_id !== undefined && event.session_id !== filter.session_id) return false;
  if (filter.instance_id !== undefined && event.instance_id !== filter.instance_id) return false;
  if (
    filter.workflow_run_id !== undefined &&
    event.workflow_run_id !== filter.workflow_run_id
  ) {
    return false;
  }
  return true;
}

export function publishLiveEvent(input: {
  type: LiveEventType;
  room_id?: number | null;
  session_id?: string | null;
  instance_id?: string | null;
  workflow_run_id?: number | null;
  payload: Record<string, unknown>;
}): LiveEventEnvelope {
  const envelope: LiveEventEnvelope = {
    id: nextEventId++,
    type: input.type,
    ...(input.room_id !== undefined ? { room_id: input.room_id } : {}),
    ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
    ...(input.instance_id !== undefined ? { instance_id: input.instance_id } : {}),
    ...(input.workflow_run_id !== undefined ? { workflow_run_id: input.workflow_run_id } : {}),
    payload: input.payload,
    created_at: new Date().toISOString(),
  };
  ring.push(envelope);
  if (ring.length > MAX_BUFFER) {
    ring.splice(0, ring.length - MAX_BUFFER);
  }
  for (const listener of listeners) {
    try {
      listener(envelope);
    } catch {
      // broken subscriber must not affect other listeners
    }
  }
  return envelope;
}

export function replayLiveEventsAfter(
  afterId: number,
  filter?: LiveEventFilter,
): LiveEventEnvelope[] {
  return ring.filter((ev) => ev.id > afterId && matchesFilter(ev, filter));
}

export function subscribeLiveEvents(
  onEvent: (event: LiveEventEnvelope) => void,
  filter?: LiveEventFilter,
): () => void {
  const wrapped = (ev: LiveEventEnvelope) => {
    if (matchesFilter(ev, filter)) onEvent(ev);
  };
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

export function installManagedLiveEventBridge(): void {
  if (managedBridgeInstalled) return;
  managedBridgeInstalled = true;
  onManagedLiveEvent((ev) => {
    publishLiveEvent({
      type: "managed.event",
      instance_id: ev.instanceId,
      session_id: ev.sessionId,
      payload: {
        sequence: ev.sequence,
        run_id: ev.run_id,
        event_type: ev.type,
        data: ev.payload,
      },
    });
  });
}

export function resetLiveEventBusForTest(): void {
  ring.length = 0;
  nextEventId = 1;
}
