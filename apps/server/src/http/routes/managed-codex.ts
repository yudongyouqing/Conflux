import type { FastifyInstance } from "fastify";
import { logAudit } from "../../core/audit.js";
import { getManagedCodexManager } from "../../core/managed-codex/manager.js";
import { listManagedEvents } from "../../core/managed-codex/store.js";
import { WEB_CONSOLE_ID, type ServerContext } from "../context.js";

/**
 * HTTP surface for the managed Codex executor: status (binding + current
 * run + queue + pending approvals), event replay, interruption and approval
 * decisions. Approvals are HUMAN actions: only the web console identity may
 * answer them — agent sessions cannot approve on the user's behalf, and the
 * actor is resolved from the session header, never the request body.
 */
export function registerManagedCodexRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError } = ctx;

  const requireManager = () => {
    const manager = getManagedCodexManager();
    if (!manager)
      throw Object.assign(new Error("managed executor unavailable"), { statusCode: 503 });
    return manager;
  };

  app.get<{ Params: { id: string } }>("/runtime-instances/:id/managed", {}, async (req, reply) => {
    try {
      const manager = requireManager();
      const status = manager.instanceStatus(req.params.id);
      const binding = db
        .prepare(`SELECT * FROM managed_codex_bindings WHERE instance_id = ?`)
        .get(req.params.id) as
        | {
            instance_id: string;
            session_id: string;
            thread_id: string;
            active_turn_id: string | null;
          }
        | undefined;
      const runs = db
        .prepare(
          `SELECT id, message_id, state, turn_id, final_text, error_code, created_at, updated_at
           FROM managed_codex_runs WHERE instance_id = ? ORDER BY id DESC LIMIT 20`,
        )
        .all(req.params.id);
      reply.send({ binding, current: status, runs });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // SSE: replays history strictly after ?after=<sequence>, then streams live
  // normalized events. The browser's EventSource auto-reconnects and repeats
  // its last event id as `after`, so old sequences never re-render. Clients
  // that prefer plain JSON (tests, CLI) get the same history snapshot.
  app.get<{ Params: { id: string }; Querystring: { after?: string; stream?: string } }>(
    "/runtime-instances/:id/managed/events",
    {},
    async (req, reply) => {
      const manager = getManagedCodexManager();
      if (!manager) {
        return reply.code(503).send({ error: "managed executor unavailable" });
      }
      const afterRaw = Number(req.query.after ?? 0);
      const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0;
      const history = listManagedEvents(db, { instanceId: req.params.id, after, limit: 200 });

      if (req.query.stream !== "1") {
        return reply.send({ events: history });
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const writeEvent = (event: unknown) => {
        const frame = event as { sequence: number };
        reply.raw.write(`id: ${frame.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      for (const row of history) {
        writeEvent({
          sequence: row.sequence,
          run_id: row.run_id,
          type: row.type,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
          created_at: row.created_at,
        });
      }
      // Subscribe if the instance is live; a dead instance keeps the stream
      // open (history only) until the client reconnects elsewhere.
      const unsubscribe = manager.subscribe(req.params.id, writeEvent) ?? undefined;
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          // broken pipe — the close handler below unsubscribes
        }
      }, 15000);
      req.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });
      await Promise.resolve(); // headers flushed; the stream stays open
    },
  );

  app.post<{ Params: { id: string }; Body: { expected_turn_id?: string | null } }>(
    "/runtime-instances/:id/managed/interrupt",
    {},
    async (req, reply) => {
      try {
        const manager = requireManager();
        const result = await manager.interrupt(req.params.id, req.body?.expected_turn_id ?? null);
        logAudit(db, {
          interface: "http",
          caller_session: WEB_CONSOLE_ID,
          action: "managed_codex_interrupt",
          args: { id: req.params.id, expected_turn_id: req.body?.expected_turn_id ?? null },
          result,
        });
        reply.send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; approvalId: string }; Body: { decision?: unknown } }>(
    "/runtime-instances/:id/managed/approvals/:approvalId",
    {},
    async (req, reply) => {
      try {
        const manager = requireManager();
        const approvalId = Number(req.params.approvalId);
        if (!Number.isInteger(approvalId) || approvalId <= 0) {
          return reply.code(400).send({ error: "invalid approval id" });
        }
        // Only the human console may answer; the actor comes from the session
        // identity resolution, never from the body.
        const sid = ctx.requireSession(req);
        if (sid !== WEB_CONSOLE_ID) {
          return reply.code(403).send({ error: "approvals are answered by the user console only" });
        }
        const result = await manager.resolveApproval(req.params.id, approvalId, req.body?.decision);
        if (!result.ok) {
          return reply.code(result.status).send({ error: result.reason });
        }
        logAudit(db, {
          interface: "http",
          caller_session: sid,
          action: "managed_codex_approval",
          args: { id: req.params.id, approvalId, decision: req.body?.decision },
        });
        reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err, WEB_CONSOLE_ID, "managed_codex_approval", {
          id: req.params.id,
          approvalId: req.params.approvalId,
        });
      }
    },
  );
}
