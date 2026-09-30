import type { FastifyInstance } from "fastify";
import { createChatRoom, deleteChatRoom, getChatRoom, listChatRooms, roomMembers, joinRoom, leaveRoom } from "../../core/chat-rooms.js";
import { logAudit } from "../../core/audit.js";
import type { ServerContext } from "../context.js";

export function registerChatRoomRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError } = ctx;

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
        const room = createChatRoom(db, {
          name: req.body.name,
          description: req.body.description,
          members: req.body.members as string[],
        });
        logAudit(db, {
          interface: "http",
          action: "create_chat_room",
          args: { name: req.body.name },
          result: { id: room.id },
        });
        return reply.status(201).send({ room });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/chat-rooms/:id", {}, async (req, reply) => {
    const ok = deleteChatRoom(db, Number(req.params.id));
    if (!ok) return reply.status(404).send({ error: "not found" });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: { session_id: string } }>(
    "/chat-rooms/:id/join",
    {},
    async (req, reply) => {
      try {
        joinRoom(db, Number(req.params.id), req.body.session_id);
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
      leaveRoom(db, req.body.session_id);
      return reply.send({ ok: true });
    },
  );

}
