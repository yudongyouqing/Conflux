import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LiveEventEnvelope } from "@conflux/shared";
import { apiUrl } from "./api";

/**
 * Subscribe to the unified `/live/events` SSE stream and invalidate matching
 * React Query caches in real time across workspaces, peer MCP calls, approvals,
 * live topology graph, and git/PR state.
 */
export function useLiveEvents(enabled = true): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    try {
      source = new EventSource(apiUrl("/live/events"));
      source.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as LiveEventEnvelope;
          switch (parsed.type) {
            case "project.updated":
              void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
              break;
            case "thread.updated":
              void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
              void qc.invalidateQueries({ queryKey: ["graph"] });
              if (parsed.thread_id) {
                void qc.invalidateQueries({ queryKey: ["thread-detail", parsed.thread_id] });
              }
              break;
            case "thread.event":
              if (parsed.thread_id) {
                void qc.invalidateQueries({ queryKey: ["thread-events", parsed.thread_id] });
                void qc.invalidateQueries({ queryKey: ["thread-detail", parsed.thread_id] });
              }
              break;
            case "approval.updated":
              void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
              if (parsed.thread_id) {
                void qc.invalidateQueries({ queryKey: ["thread-detail", parsed.thread_id] });
                void qc.invalidateQueries({ queryKey: ["thread-events", parsed.thread_id] });
              }
              break;
            case "peer.message":
              void qc.invalidateQueries({ queryKey: ["mesh-calls"] });
              void qc.invalidateQueries({ queryKey: ["graph"] });
              void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
              break;
            case "git.dirty":
              if (parsed.thread_id) {
                void qc.invalidateQueries({ queryKey: ["thread-git-status", parsed.thread_id] });
                void qc.invalidateQueries({ queryKey: ["thread-git-diff", parsed.thread_id] });
                void qc.invalidateQueries({ queryKey: ["thread-pr-detail", parsed.thread_id] });
                void qc.invalidateQueries({ queryKey: ["thread-detail", parsed.thread_id] });
              }
              break;
            case "room.message":
            case "room.task":
              void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
              if (parsed.room_id) {
                void qc.invalidateQueries({ queryKey: ["room-detail", parsed.room_id] });
              }
              break;
            case "workflow.updated":
              void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
              void qc.invalidateQueries({ queryKey: ["workflow-runs"] });
              break;
            case "context.updated":
              void qc.invalidateQueries({ queryKey: ["context"] });
              break;
          }
        } catch {
          // ignore non-JSON heartbeat lines
        }
      };
    } catch {
      // EventSource unavailable in non-browser unit test env
    }
    return () => {
      source?.close();
    };
  }, [enabled, qc]);
}
