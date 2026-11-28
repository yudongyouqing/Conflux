import type { FastifyInstance } from "fastify";
import type { ContextKind, ManagedDeliveryMode } from "@conflux/shared";
import {
  broadcastRoom,
  createRoom,
  deleteRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  listRooms,
  listRoomTasks,
  summonRoomAgent,
} from "../../core/rooms.js";
import { askThread, listMessages, replyMessage } from "../../core/messages.js";
import {
  deleteContext,
  listProjectContext,
  listRoomContext,
  publishContext,
  queryContext,
  updateContext,
} from "../../core/context.js";
import { onWorkflowStepMessageCompleted } from "../../core/workflows.js";
import { listPendingThreadApprovals } from "../../core/threads/store.js";
import { resourceId, WEB_CONSOLE_ID, type ServerContext } from "../context.js";

export function registerRoomAndMemoryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, sendHttpError, write } = ctx;

  // ---- Rooms ----

  app.get<{ Querystring: { project_id?: string } }>("/rooms", async (req, reply) => {
    const projectId =
      req.query.project_id === "global"
        ? null
        : req.query.project_id
          ? resourceId(req.query.project_id)
          : undefined;
    return reply.send({ rooms: listRooms(db, projectId) });
  });

  app.post<{
    Body: { name: string; description?: string | null; project_id?: number | null; members?: string[] };
  }>("/rooms", async (req, reply) => {
    const room = await write(() => createRoom(db, req.body));
    return reply.code(201).send({ room });
  });

  app.get<{ Params: { id: string } }>("/rooms/:id", async (req, reply) => {
    const room = getRoom(db, resourceId(req.params.id));
    if (!room) return sendHttpError(reply, 404, "room not found");
    return reply.send({
      room,
      tasks: listRoomTasks(db, room.id),
      messages: listMessages(db, { room_id: room.id, limit: 150 }),
      pending_approvals: listPendingThreadApprovals(db, { roomId: room.id }),
    });
  });

  app.delete<{ Params: { id: string } }>("/rooms/:id", async (req, reply) => {
    const ok = await write(() => deleteRoom(db, resourceId(req.params.id)));
    if (!ok) return sendHttpError(reply, 404, "room not found");
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: { thread_id: string } }>(
    "/rooms/:id/join",
    async (req, reply) => {
      const room = await write(() => joinRoom(db, resourceId(req.params.id), req.body.thread_id));
      return reply.send({ room });
    },
  );

  app.post<{ Params: { id: string }; Body: { thread_id: string } }>(
    "/rooms/:id/leave",
    async (req, reply) => {
      const room = await write(() => leaveRoom(db, resourceId(req.params.id), req.body.thread_id));
      if (!room) return sendHttpError(reply, 404, "room not found");
      return reply.send({ room });
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      executor_thread_id: string;
      prompt: string;
      sender_thread_id?: string;
      delivery_mode?: ManagedDeliveryMode;
    };
  }>("/rooms/:id/summon", async (req, reply) => {
    const res = await summonRoomAgent(db, {
      room_id: resourceId(req.params.id),
      executor_thread_id: req.body.executor_thread_id,
      prompt: req.body.prompt,
      initiator_thread_id: req.body.sender_thread_id ?? WEB_CONSOLE_ID,
      delivery_mode: req.body.delivery_mode,
    });
    return reply.send(res);
  });

  app.post<{
    Params: { id: string };
    Body: { prompt: string; sender_thread_id?: string };
  }>("/rooms/:id/broadcast", async (req, reply) => {
    const res = await broadcastRoom(db, {
      room_id: resourceId(req.params.id),
      prompt: req.body.prompt,
      sender_thread_id: req.body.sender_thread_id ?? WEB_CONSOLE_ID,
    });
    return reply.send(res);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/rooms/:id/context",
    async (req, reply) => {
      const entries = listRoomContext(
        db,
        resourceId(req.params.id),
        req.query.limit ? Number(req.query.limit) : 100,
      );
      return reply.send({ entries });
    },
  );

  // ---- Messages (also consumed by Electron desktop-notify.cjs) ----

  app.get<{
    Querystring: { from?: string; to?: string; room_id?: string; status?: string; limit?: string };
  }>("/messages", async (req, reply) => {
    const messages = listMessages(db, {
      from: req.query.from,
      to: req.query.to,
      room_id: req.query.room_id ? resourceId(req.query.room_id) : undefined,
      status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return reply.send({ messages });
  });

  app.post<{
    Body: {
      to_thread: string;
      question: string;
      room_id?: number | null;
      delivery_mode?: ManagedDeliveryMode;
    };
  }>("/messages/ask", async (req, reply) => {
    const outcome = await askThread(db, {
      from_thread: requireSession(req),
      to_thread: req.body.to_thread,
      question: req.body.question,
      room_id: req.body.room_id ?? null,
      delivery_mode: req.body.delivery_mode,
    });
    return reply.send(outcome);
  });

  app.post<{ Params: { id: string }; Body: { reply: string } }>(
    "/messages/:id/reply",
    async (req, reply) => {
      const sid = requireSession(req);
      const msgId = resourceId(req.params.id);
      const msg = await write(() => replyMessage(db, msgId, sid, req.body.reply));
      await onWorkflowStepMessageCompleted(db, msgId, { ok: true, output: req.body.reply });
      return reply.send({ message: msg });
    },
  );

  // ---- Shared Context Memory (optimistic locking + project/room scoping) ----

  app.get<{
    Querystring: {
      query?: string;
      thread_id?: string;
      project_id?: string;
      room_id?: string;
      kind?: ContextKind;
      pinned?: string;
      limit?: string;
    };
  }>("/context", async (req, reply) => {
    const entries = queryContext(db, {
      query: req.query.query,
      thread_id: req.query.thread_id,
      project_id: req.query.project_id ? resourceId(req.query.project_id) : undefined,
      room_id: req.query.room_id ? resourceId(req.query.room_id) : undefined,
      kind: req.query.kind,
      pinned:
        req.query.pinned === "true" || req.query.pinned === "1"
          ? true
          : req.query.pinned === "false" || req.query.pinned === "0"
            ? false
            : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return reply.send({ entries });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/projects/:id/context",
    async (req, reply) => {
      const entries = listProjectContext(
        db,
        resourceId(req.params.id),
        req.query.limit ? Number(req.query.limit) : 100,
      );
      return reply.send({ entries });
    },
  );

  app.post<{
    Body: {
      title: string;
      content: string;
      tags?: string[];
      project_id?: number | null;
      room_id?: number | null;
      kind?: ContextKind;
      pinned?: boolean;
    };
  }>("/context", async (req, reply) => {
    const entry = await write(() =>
      publishContext(db, {
        thread_id: requireSession(req),
        project_id: req.body.project_id ?? null,
        room_id: req.body.room_id ?? null,
        kind: req.body.kind,
        pinned: req.body.pinned,
        title: req.body.title,
        content: req.body.content,
        tags: req.body.tags,
      }),
    );
    return reply.code(201).send({ entry });
  });

  app.put<{
    Params: { id: string };
    Body: {
      title?: string;
      content?: string;
      tags?: string[] | null;
      project_id?: number | null;
      room_id?: number | null;
      kind?: ContextKind;
      pinned?: boolean;
      expected_version?: number;
    };
  }>("/context/:id", async (req, reply) => {
    const entry = updateContext(db, resourceId(req.params.id), req.body ?? {});
    if (!entry) return sendHttpError(reply, 404, "context entry not found");
    return reply.send({ entry });
  });

  app.delete<{ Params: { id: string } }>("/context/:id", async (req, reply) => {
    const ok = await write(() => deleteContext(db, resourceId(req.params.id)));
    if (!ok) return sendHttpError(reply, 404, "context entry not found");
    return reply.send({ ok: true });
  });
}
