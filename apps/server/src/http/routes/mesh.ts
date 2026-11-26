import type { FastifyInstance } from "fastify";
import type { IncomingCallMode, RuntimeId } from "@conflux/shared";
import { detectLocalNetworkInfo } from "../../core/hooks.js";
import { ensureMcpThread } from "../../mcp/server.js";
import {
  approvePendingCall,
  askThread,
  checkInbox,
  hangupCall,
  listMessages,
  replyMessage,
} from "../../core/messages.js";
import {
  getThread,
  isValidIncomingCallMode,
  isValidRuntime,
  updateThread,
} from "../../core/threads/store.js";
import { getThreadManager } from "../../core/threads/executor.js";
import { publishLiveEvent } from "../../core/event-bus.js";
import { resourceId, type ServerContext } from "../context.js";

export function registerMeshRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendHttpError, write, port } = ctx;

  app.get("/system/network", async (_req, reply) =>
    reply.send(detectLocalNetworkInfo(port)),
  );

  app.get<{ Querystring: { status?: "active" | "history" | "all"; limit?: string } }>(
    "/mesh/calls",
    async (req, reply) => {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const mode = req.query.status ?? "all";
      const statuses =
        mode === "active"
          ? ["pending", "awaiting_approval", "seen"]
          : mode === "history"
            ? ["replied", "read", "cancelled"]
            : undefined;
      const calls = listMessages(db, { statuses, limit });
      return reply.send({ calls });
    },
  );

  app.post<{
    Body: {
      from_thread?: string;
      to_thread: string;
      question: string;
      context?: string | null;
    };
  }>("/mesh/calls", async (req, reply) => {
    const from = req.body?.from_thread?.trim() || ctx.requireSession(req);
    const result = await askThread(db, {
      from_thread: from,
      to_thread: req.body?.to_thread ?? "",
      question: req.body?.question ?? "",
      context: req.body?.context ?? null,
    });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string } }>("/mesh/calls/:id/approve", async (req, reply) => {
    const result = await approvePendingCall(db, resourceId(req.params.id));
    return reply.send(result);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/mesh/calls/:id/hangup",
    async (req, reply) => {
      const message = await write(() =>
        hangupCall(db, resourceId(req.params.id), req.body?.reason?.trim() || "已由用户手动挂断"),
      );
      return reply.send({ message });
    },
  );

  app.post<{ Params: { id: string }; Body: { reply: string; from_thread?: string } }>(
    "/mesh/calls/:id/reply",
    async (req, reply) => {
      if (!req.body?.reply?.trim()) return sendHttpError(reply, 400, "reply is required");
      const replier = req.body.from_thread?.trim() || ctx.requireSession(req);
      const message = await write(() =>
        replyMessage(db, resourceId(req.params.id), replier, req.body.reply.trim()),
      );
      return reply.send({ message });
    },
  );

  /**
   * 1:1 external CLI hook heartbeat + inbox poll in a single round-trip.
   * Called by `conflux hook check` from Stop / UserPromptSubmit / SessionStart.
   */
  app.post<{
    Body: {
      session_id: string;
      cwd: string;
      host?: string;
      runtime?: RuntimeId;
      name?: string;
      incoming_call_mode?: IncomingCallMode;
    };
  }>("/mesh/peers/heartbeat", async (req, reply) => {
    const sessionId = req.body?.session_id?.trim();
    const cwd = req.body?.cwd?.trim();
    if (!sessionId || !cwd) {
      return sendHttpError(reply, 400, "session_id and cwd are required");
    }
    const runtime = isValidRuntime(req.body.runtime) ? req.body.runtime : "claude";
    const peerId = await write(() =>
      ensureMcpThread(db, {
        id: sessionId,
        external_session_id: sessionId,
        project_dir: cwd,
        host: req.body.host,
        runtime,
        name: req.body.name,
        incoming_call_mode: req.body.incoming_call_mode,
      }),
    );
    const inbox = await write(() => checkInbox(db, peerId));
    return reply.send({ peer: getThread(db, peerId), inbox });
  });

  app.post<{ Body: { session_id: string } }>("/mesh/peers/offline", async (req, reply) => {
    const sessionId = req.body?.session_id?.trim();
    if (!sessionId) return sendHttpError(reply, 400, "session_id is required");
    const updated = await write(() => updateThread(db, sessionId, { state: "stopped" }));
    if (updated) {
      publishLiveEvent({
        type: "thread.updated",
        project_id: updated.project_id,
        thread_id: updated.id,
        payload: { action: "offline", thread: updated },
      });
    }
    return reply.send({ ok: true, peer: updated });
  });

  app.post<{ Params: { id: string }; Body: { incoming_call_mode: IncomingCallMode } }>(
    "/threads/:id/call-mode",
    async (req, reply) => {
      const mode = req.body?.incoming_call_mode;
      if (!isValidIncomingCallMode(mode)) {
        return sendHttpError(reply, 400, "incoming_call_mode must be auto | ask | dnd");
      }
      const existing = getThread(db, req.params.id);
      if (!existing) return sendHttpError(reply, 404, "thread not found");
      const updated = await write(() =>
        updateThread(db, req.params.id, { incoming_call_mode: mode }),
      );
      if (!updated) return sendHttpError(reply, 404, "thread not found");
      const manager = getThreadManager();
      const decorated = manager ? manager.decorateThread(updated) : updated;
      publishLiveEvent({
        type: "thread.updated",
        project_id: decorated.project_id,
        thread_id: decorated.id,
        payload: { action: "call_mode_updated", thread: decorated },
      });
      return reply.send({ thread: decorated });
    },
  );
}
