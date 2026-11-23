import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LiveEventEnvelope } from "@conflux/shared";

/**
 * Subscribe to the server's unified `/live/events` SSE stream and trigger
 * targeted React Query invalidations for managed streams, rooms, workflows,
 * shared memory, and graph state. Falls back silently in environments without
 * EventSource (such as unit tests).
 */
export function useLiveEvents(enabled = true): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    try {
      source = new EventSource("/live/events");
    } catch {
      return;
    }

    source.onmessage = (event) => {
      let ev: LiveEventEnvelope;
      try {
        ev = JSON.parse(event.data) as LiveEventEnvelope;
      } catch {
        return;
      }
      if (ev.type === "managed.event" && ev.instance_id) {
        void qc.invalidateQueries({ queryKey: ["managed-events", ev.instance_id] });
        void qc.invalidateQueries({ queryKey: ["managed-status", ev.instance_id] });
      } else if (ev.type === "room.message" || ev.type === "room.task") {
        if (ev.room_id != null) {
          void qc.invalidateQueries({ queryKey: ["room-messages", ev.room_id] });
          void qc.invalidateQueries({ queryKey: ["room-tasks", ev.room_id] });
        }
        void qc.invalidateQueries({ queryKey: ["graph"] });
      } else if (ev.type === "workflow.updated") {
        void qc.invalidateQueries({ queryKey: ["workflow-runs"] });
      } else if (ev.type === "context.updated") {
        if (ev.room_id != null) {
          void qc.invalidateQueries({ queryKey: ["room-context", ev.room_id] });
        }
        void qc.invalidateQueries({ queryKey: ["context"] });
        void qc.invalidateQueries({ queryKey: ["graph"] });
      }
    };

    return () => {
      source?.close();
    };
  }, [enabled, qc]);
}
