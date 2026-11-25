import type { FastifyInstance } from "fastify";
import {
  replayLiveEventsAfter,
  subscribeLiveEvents,
  type LiveEventFilter,
} from "../../core/event-bus.js";

/**
 * Unified SSE live event stream (`/live/events`) with Last-Event-ID replay and
 * immediate header flush so browsers and fetch clients connect without stalling.
 */
export function registerLiveEventsRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      after?: string;
      project_id?: string;
      thread_id?: string;
      room_id?: string;
      workflow_run_id?: string;
    };
  }>("/live/events", {}, async (req, reply) => {
    const headerLastId = req.headers["last-event-id"];
    const rawAfter = req.query.after ?? (typeof headerLastId === "string" ? headerLastId : "0");
    const parsedAfter = Number(rawAfter);
    const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

    const filter: LiveEventFilter = {};
    if (req.query.project_id && Number.isFinite(Number(req.query.project_id))) {
      filter.project_id = Number(req.query.project_id);
    }
    if (req.query.thread_id) filter.thread_id = req.query.thread_id;
    if (req.query.room_id && Number.isFinite(Number(req.query.room_id))) {
      filter.room_id = Number(req.query.room_id);
    }
    if (req.query.workflow_run_id && Number.isFinite(Number(req.query.workflow_run_id))) {
      filter.workflow_run_id = Number(req.query.workflow_run_id);
    }

    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) reply.raw.setHeader(k, v);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders?.();
    reply.raw.write(": connected\n\n");

    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    };

    const writeEvent = (ev: { id: number }) => {
      if (closed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch {
        cleanup();
      }
    };

    for (const ev of replayLiveEventsAfter(after, filter)) {
      writeEvent(ev);
    }

    if (!closed) {
      unsubscribe = subscribeLiveEvents(writeEvent, filter);
      heartbeat = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          cleanup();
        }
      }, 15_000);
      heartbeat.unref?.();
      reply.raw.on("close", cleanup);
    }
    await Promise.resolve();
  });
}
