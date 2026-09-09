import type { FastifyInstance } from "fastify";
import {
  publishContext,
  updateContext,
  deleteContext,
  listMyContext,
} from "../../core/context.js";
import { queryContext } from "../../core/search.js";
import type { ServerContext } from "../context.js";

interface ContextBody {
  title: string;
  content: string;
  tags?: string[];
}
interface UpdateContextBody {
  title?: string;
  content?: string;
  tags?: string[];
}
interface QueryContextQs {
  query?: string;
  session_id?: string;
  tags?: string;
  limit?: string;
}

export function registerContextRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, audit, sendError, sendHttpError } = ctx;

  // POST /context
  app.post<{ Body: ContextBody }>("/context", {
    schema: {
      body: {
        type: "object",
        required: ["title", "content"],
        properties: {
          title: { type: "string", maxLength: 300 },
          content: { type: "string", maxLength: 50000 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entry = publishContext(db, {
        session_id: sid,
        title: req.body.title,
        content: req.body.content,
        tags: req.body.tags ?? null,
      });
      audit(sid, "publish_context", { title: req.body.title, tags: req.body.tags }, { entry_id: entry.id });
      return reply.send({ entry });
    } catch (err) {
      return sendError(reply, err, sid, "publish_context");
    }
  });

  // GET /context/mine
  app.get("/context/mine", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entries = listMyContext(db, sid);
      audit(sid, "list_my_context", {}, { count: entries.length });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err, sid, "list_my_context");
    }
  });

  // GET /context/query
  app.get<{ Querystring: QueryContextQs }>("/context/query", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entries = queryContext(db, {
        query: req.query.query,
        session_id: req.query.session_id,
        tags: req.query.tags ? String(req.query.tags).split(",") : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      audit(sid, "query_context", req.query as Record<string, unknown>, { count: entries.length });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err, sid, "query_context");
    }
  });

  // PUT /context/:id
  app.put<{ Params: { id: string }; Body: UpdateContextBody }>("/context/:id", {
    schema: {
      body: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 300 },
          content: { type: "string", maxLength: 50000 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const entry = updateContext(db, Number(req.params.id), sid, {
        title: req.body.title,
        content: req.body.content,
        tags: req.body.tags,
      });
      audit(sid, "update_context", { id: req.params.id }, entry ? { id: entry.id } : null);
      if (!entry) return sendHttpError(reply, 404, "not found");
      return reply.send({ entry });
    } catch (err) {
      return sendError(reply, err, sid, "update_context");
    }
  });

  // DELETE /context/:id
  app.delete<{ Params: { id: string } }>("/context/:id", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const ok = deleteContext(db, Number(req.params.id), sid);
      audit(sid, "delete_context", { id: req.params.id }, { ok });
      if (!ok) return sendHttpError(reply, 404, "not found");
      return reply.send({ deleted: true });
    } catch (err) {
      return sendError(reply, err, sid, "delete_context");
    }
  });
}
