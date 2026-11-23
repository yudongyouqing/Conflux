import { resourceId } from "../context.js";
import type { FastifyInstance } from "fastify";
import type { ContextKind } from "@conflux/shared";
import {
  publishContext,
  updateContext,
  deleteContext,
  listMyContext,
  listRoomContext,
} from "../../core/context.js";
import { queryContext } from "../../core/search.js";
import type { ServerContext } from "../context.js";

interface ContextBody {
  title: string;
  content: string;
  tags?: string[];
  room_id?: number | null;
  kind?: ContextKind;
  pinned?: boolean;
}
interface UpdateContextBody {
  title?: string;
  content?: string;
  tags?: string[];
  room_id?: number | null;
  kind?: ContextKind;
  pinned?: boolean;
}
interface QueryContextQs {
  query?: string;
  session_id?: string;
  room_id?: string;
  kind?: ContextKind;
  pinned?: string;
  tags?: string;
  limit?: string;
}

export function registerContextRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, audit, sendError, sendHttpError, write } = ctx;

  // POST /context
  app.post<{ Body: ContextBody }>(
    "/context",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string", maxLength: 300 },
            content: { type: "string", maxLength: 50000 },
            tags: { type: "array", items: { type: "string" } },
            room_id: { type: "integer", nullable: true },
            kind: { type: "string", enum: ["note", "decision", "artifact", "handoff"] },
            pinned: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const sid = requireSession(req);
      try {
        const entry = await write(() => {
          const created = publishContext(db, {
            session_id: sid,
            title: req.body.title,
            content: req.body.content,
            tags: req.body.tags ?? null,
            room_id: req.body.room_id ?? null,
            kind: req.body.kind,
            pinned: req.body.pinned,
          });
          audit(
            sid,
            "publish_context",
            { title: req.body.title, tags: req.body.tags },
            { entry_id: created.id },
          );
          return created;
        });
        return reply.send({ entry });
      } catch (err) {
        return sendError(reply, err, sid, "publish_context");
      }
    },
  );

  // GET /context/mine
  app.get("/context/mine", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entries = await write(() => {
        const found = listMyContext(db, sid);
        audit(sid, "list_my_context", {}, { count: found.length });
        return found;
      });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err, sid, "list_my_context");
    }
  });

  // GET /context/query
  app.get<{ Querystring: QueryContextQs }>("/context/query", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entries = await write(() => {
        const found = queryContext(db, {
          query: req.query.query,
          session_id: req.query.session_id,
          room_id: req.query.room_id ? resourceId(req.query.room_id) : undefined,
          kind: req.query.kind,
          pinned:
            req.query.pinned === "true" || req.query.pinned === "1"
              ? true
              : req.query.pinned === "false" || req.query.pinned === "0"
                ? false
                : undefined,
          tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        audit(sid, "query_context", req.query as Record<string, unknown>, { count: found.length });
        return found;
      });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err, sid, "query_context");
    }
  });

  // PUT /context/:id
  app.put<{ Params: { id: string }; Body: UpdateContextBody }>(
    "/context/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 300 },
            content: { type: "string", maxLength: 50000 },
            tags: { type: "array", items: { type: "string" } },
            room_id: { type: "integer", nullable: true },
            kind: { type: "string", enum: ["note", "decision", "artifact", "handoff"] },
            pinned: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const sid = requireSession(req);
      try {
        const entry = await write(() => {
          const updated = updateContext(db, resourceId(req.params.id), sid, {
            title: req.body.title,
            content: req.body.content,
            tags: req.body.tags,
            room_id: req.body.room_id,
            kind: req.body.kind,
            pinned: req.body.pinned,
          });
          audit(sid, "update_context", { id: req.params.id }, updated ? { id: updated.id } : null);
          return updated;
        });
        if (!entry) return sendHttpError(reply, 404, "not found");
        return reply.send({ entry });
      } catch (err) {
        return sendError(reply, err, sid, "update_context");
      }
    },
  );

  // DELETE /context/:id
  app.delete<{ Params: { id: string } }>("/context/:id", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const ok = await write(() => {
        const deleted = deleteContext(db, resourceId(req.params.id), sid);
        audit(sid, "delete_context", { id: req.params.id }, { ok: deleted });
        return deleted;
      });
      if (!ok) return sendHttpError(reply, 404, "not found");
      return reply.send({ deleted: true });
    } catch (err) {
      return sendError(reply, err, sid, "delete_context");
    }
  });

  // GET /chat-rooms/:id/context — pinned & structured memory for one room
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/chat-rooms/:id/context",
    {},
    async (req, reply) => {
      try {
        const entries = listRoomContext(
          db,
          resourceId(req.params.id),
          req.query.limit ? Number(req.query.limit) : 100,
        );
        return reply.send({ entries });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
