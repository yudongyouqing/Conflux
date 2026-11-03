import type { FastifyInstance } from "fastify";
import { createChatRoom, deleteChatRoom, getChatRoom, listChatRooms, roomMembers, joinRoom, leaveRoom } from "../../core/chat-rooms.js";
import {
  readRoom,
  roomStatus,
  prepareSummon,
  completeSummon,
  prepareBroadcast,
  completeBroadcast,
  listRoomMessages,
} from "../../core/room-orchestrator.js";
import { logAudit } from "../../core/audit.js";
import type { ServerContext } from "../context.js";

export function registerChatRoomRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError, write } = ctx;

  app.get("/chat-rooms", {}, async (_req, reply) => {
    try {
      return reply.send({ rooms: listChatRooms(db) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/chat-rooms/:id", {}, async (req, reply) => {
    const room = getChatRoom(db, Number(req.params.id));
    if (!room) return reply.status(404).send({ error: "not found" });
    return reply.send({ room, members: roomMembers(db, room.id) });
  });

  app.post<{ Body: { name: string; description?: string; members: string[] } }>(
    "/chat-rooms",
    {},
    async (req, reply) => {
      try {
        const room = await write(() => {
          const created = createChatRoom(db, {
            name: req.body.name,
            description: req.body.description,
            members: req.body.members as string[],
          });
          logAudit(db, {
            interface: "http",
            action: "create_chat_room",
            args: { name: req.body.name },
            result: { id: created.id },
          });
          return created;
        });
        return reply.status(201).send({ room });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/chat-rooms/:id", {}, async (req, reply) => {
    const ok = await write(() => deleteChatRoom(db, Number(req.params.id)));
    if (!ok) return reply.status(404).send({ error: "not found" });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: { session_id: string } }>(
    "/chat-rooms/:id/join",
    {},
    async (req, reply) => {
      try {
        await write(() => joinRoom(db, Number(req.params.id), req.body.session_id));
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Body: { session_id: string } }>(
    "/chat-rooms/leave",
    {},
    async (req, reply) => {
      await write(() => leaveRoom(db, req.body.session_id));
      return reply.send({ ok: true });
    },
  );

  // GET /chat-rooms/:id/orchestrate — tasks + status for the UI (#152)
  app.get<{ Params: { id: string } }>("/chat-rooms/:id/orchestrate", {}, async (req, reply) => {
    try {
      const roomId = Number(req.params.id);
      const data = readRoom(db, roomId);
      const status = roomStatus(db, roomId);
      return reply.send({ tasks: data.tasks, status });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /chat-rooms/:id/summon — human initiates an agent task (#152)
  app.post<
    { Params: { id: string }; Body: { executor_session_id: string; prompt: string; sender_session_id?: string } }
  >("/chat-rooms/:id/summon", {}, async (req, reply) => {
    try {
      // Phase 1 (retryable, database-only): the task row + audit. Phase 2
      // (terminal injection / headless wake spawn) runs strictly after the
      // commit — an injected prompt or spawned process cannot be rolled
      // back, and a retry must never re-run either.
      const task = await write(() => {
        const created = prepareSummon(db, {
          room_id: Number(req.params.id),
          initiator_session_id: req.body.sender_session_id ?? "web-console",
          executor_session_id: req.body.executor_session_id,
          prompt: req.body.prompt,
        });
        logAudit(db, {
          interface: "http",
          action: "room_summon",
          args: { room_id: Number(req.params.id), executor: req.body.executor_session_id },
          result: { task_id: created.id },
        });
        return created;
      });
      const result = completeSummon(db, {
        room_id: Number(req.params.id),
        initiator_session_id: req.body.sender_session_id ?? "web-console",
        executor_session_id: req.body.executor_session_id,
        prompt: req.body.prompt,
      }, task);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /chat-rooms/:id/broadcast — one prompt, every member self-selects (#151)
  app.post<
    { Params: { id: string }; Body: { prompt: string; sender_session_id?: string } }
  >("/chat-rooms/:id/broadcast", {}, async (req, reply) => {
    try {
      // Phase 1 (retryable, database-only): question inserts + delivery
      // claims + audit. Phase 2 (per-member wakes / typed pushes) runs
      // strictly after the commit.
      const prepared = await write(() => {
        const ready = prepareBroadcast(db, {
          room_id: Number(req.params.id),
          sender_session_id: req.body.sender_session_id ?? "web-console",
          prompt: req.body.prompt,
        });
        logAudit(db, {
          interface: "http",
          action: "room_broadcast",
          args: { room_id: Number(req.params.id), members: ready.members.length },
        });
        return ready;
      });
      const result = completeBroadcast(db, {
        room_id: Number(req.params.id),
        sender_session_id: req.body.sender_session_id ?? "web-console",
        prompt: req.body.prompt,
      }, prepared);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /chat-rooms/:id/messages — the room's shared thread (#151)
  app.get<{ Params: { id: string } }>("/chat-rooms/:id/messages", {}, async (req, reply) => {
    try {
      return reply.send({ messages: listRoomMessages(db, Number(req.params.id)) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

}
