import type { FastifyInstance } from "fastify";
import {
  checkInbox,
  checkReplies,
  listMessages,
  listPeerMessages,
  listEdgeMessages,
  getEdge,
} from "../../core/messages.js";
import { maybePushReply } from "../../core/mail-push.js";
import { replyAsk } from "../../core/messages.js";
import { prepareAsk, prepareRetryDelivery, completeAsk } from "../../core/ask.js";
import { getSession, heartbeat } from "../../core/sessions.js";
import { logAudit } from "../../core/audit.js";
import { httpError, WEB_CONSOLE_ID, type ServerContext } from "../context.js";

interface AskBody {
  to_session: string;
  question: string;
}
interface ReplyBody {
  reply: string;
}
interface MessagesQs {
  from?: string;
  to?: string;
  status?: string;
  since?: string;
  limit?: string;
}

export function registerMessageRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, audit, sendError, sendHttpError, write } = ctx;

  app.post<{ Params: { id: string } }>("/messages/:id/retry", {}, async (req, reply) => {
    let actor: string | undefined;
    try {
      const resolvedActor = requireSession(req);
      actor = resolvedActor;
      // Phase 1 (retryable, database-only): the delivery claim + audit.
      // Phase 2 (external wake) runs strictly after the commit — a rollback
      // would erase the claim and a retry would launch the wake twice.
      const prepared = await write(() => {
        const claimed = prepareRetryDelivery(db, Number(req.params.id), resolvedActor);
        logAudit(db, {
          caller_session: resolvedActor,
          interface: "http",
          action: "retry_message_delivery",
          args: { id: claimed.message.id },
        });
        return claimed;
      });
      const result = await completeAsk(db, prepared);
      return reply.send(result);
    } catch (error) {
      return sendError(reply, error, actor, "retry_message_delivery", { id: req.params.id });
    }
  });

  // POST /messages/ask
  app.post<{ Body: AskBody }>(
    "/messages/ask",
    {
      schema: {
        body: {
          type: "object",
          required: ["to_session", "question"],
          properties: {
            to_session: { type: "string" },
            question: { type: "string", maxLength: 20000 },
          },
        },
      },
    },
    async (req, reply) => {
      const sid = requireSession(req);
      try {
        // Database-only phase (question insert + delivery claim + audit) is
        // retried as one clean transaction; the wake spawn happens once,
        // strictly after the commit.
        const prepared = await write(() => {
          const claimed = prepareAsk(db, {
            from_session: sid,
            to_session: req.body.to_session,
            question: req.body.question,
          });
          audit(sid, "ask_session", { to_session: req.body.to_session }, { message_id: claimed.message.id });
          return claimed;
        });
        const { message: msg, wake } = await completeAsk(db, prepared);
        return reply.send({ message: msg, wake });
      } catch (err) {
        return sendError(reply, err, sid, "ask_session");
      }
    },
  );

  // GET /messages/inbox
  app.get("/messages/inbox", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const inbox = await write(() => {
        const found = checkInbox(db, sid);
        audit(sid, "check_inbox", {}, { count: found.length });
        return found;
      });
      return reply.send({ inbox });
    } catch (err) {
      return sendError(reply, err, sid, "check_inbox");
    }
  });

  // POST /messages/:id/reply
  app.post<{ Params: { id: string }; Body: ReplyBody }>(
    "/messages/:id/reply",
    {
      schema: {
        body: {
          type: "object",
          required: ["reply"],
          properties: { reply: { type: "string", maxLength: 20000 } },
        },
      },
    },
    async (req, reply) => {
      const sid = requireSession(req);
      try {
        // The reply write is retried as one transaction; typing the typed
        // push into the asker's terminal is external and runs after commit.
        const msg = await write(() => {
          const replied = replyAsk(db, Number(req.params.id), sid, req.body.reply);
          audit(sid, "reply_ask", { id: req.params.id }, { message_id: replied.id });
          return replied;
        });
        maybePushReply(db, msg.from_session);
        return reply.send({ message: msg });
      } catch (err) {
        return sendError(reply, err, sid, "reply_ask");
      }
    },
  );

  // GET /messages/replies
  app.get<{ Querystring: { since?: string } }>("/messages/replies", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const replies = await write(() => {
        const found = checkReplies(db, sid, req.query.since);
        audit(sid, "check_replies", { since: req.query.since }, { count: found.length });
        return found;
      });
      return reply.send({ replies });
    } catch (err) {
      return sendError(reply, err, sid, "check_replies");
    }
  });

  // GET /messages — global message list with filters (for frontend message-flow viewer)
  app.get<{ Querystring: MessagesQs }>("/messages", {}, async (req, reply) => {
    try {
      const messages = listMessages(db, {
        from_session: req.query.from,
        to_session: req.query.to,
        status: (req.query.status as never) ?? undefined,
        since: req.query.since,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /messages/peers?a=<id>&b=<id> — two-way flow between any two sessions
  // (legacy pair view; the edge channel view below is the primary)
  app.get<{ Querystring: { a?: string; b?: string } }>(
    "/messages/peers",
    {},
    async (req, reply) => {
      const { a, b } = req.query;
      if (!a || !b) return sendHttpError(reply, 400, "missing a/b query params");
      try {
        const messages = listPeerMessages(db, a, b);
        return reply.send({ messages });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- edge channels (directed conversation channels) ----

  // GET /edges/:id/messages — the channel's exchange history
  app.get<{ Params: { id: string }; Querystring: { all?: string } }>(
    "/edges/:id/messages",
    {},
    async (req, reply) => {
      try {
        const edgeId = Number(req.params.id);
        const edge = getEdge(db, edgeId);
        if (!edge) return sendHttpError(reply, 404, "edge not found");
        return reply.send({
          edge: { id: edge.id, from: edge.from_session, to: edge.to_session },
          messages: listEdgeMessages(db, edgeId, req.query.all === "true" ? null : undefined),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // POST /edges/:id/ask — speak ON the channel as its initiator (the
  // console for its own channels; on A's behalf for A→B channels)
  app.post<{ Params: { id: string }; Body: { question: string } }>(
    "/edges/:id/ask",
    {
      schema: {
        body: {
          type: "object",
          required: ["question"],
          properties: { question: { type: "string", maxLength: 20000 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const edgeId = Number(req.params.id);
        const edge = getEdge(db, edgeId);
        if (!edge) return sendHttpError(reply, 404, "edge not found");
        const from = edge.from_session;
        const prepared = await write(() => {
          // No heartbeat for CLI senders: speaking for them must not fake
          // their liveness.
          if (from === WEB_CONSOLE_ID) heartbeat(db, WEB_CONSOLE_ID);
          const claimed = prepareAsk(db, {
            from_session: from,
            to_session: edge.to_session,
            question: req.body.question,
          });
          logAudit(db, {
            caller_session: from,
            interface: "http",
            action: "edge_ask",
            args: { edge: edgeId },
            result: { message_id: claimed.message.id },
          });
          return claimed;
        });
        const { message: msg, wake } = await completeAsk(db, prepared);
        return reply.send({ message: msg, wake });
      } catch (err) {
        return sendError(reply, err, undefined, "edge_ask");
      }
    },
  );

  // GET /web/peer-messages?peer=<id> — two-way flow between the web console and a session
  app.get<{ Querystring: { peer?: string } }>("/web/peer-messages", {}, async (req, reply) => {
    const peer = req.query.peer;
    if (!peer) return sendHttpError(reply, 400, "missing peer query param");
    try {
      const messages = listPeerMessages(db, WEB_CONSOLE_ID, peer);
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "web_peer_messages");
    }
  });

  // POST /web/ask — ask a session from the web console (Drawer input box).
  // Optional from_session lets the UI speak AS a CLI session ("let A ask B");
  // omitted, the sender is the web console itself.
  app.post<{ Body: { to_session: string; question: string; from_session?: string } }>(
    "/web/ask",
    {
      schema: {
        body: {
          type: "object",
          required: ["to_session", "question"],
          properties: {
            to_session: { type: "string" },
            question: { type: "string", maxLength: 20000 },
            from_session: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        let from = WEB_CONSOLE_ID;
        if (req.body.from_session && req.body.from_session !== WEB_CONSOLE_ID) {
          const sender = getSession(db, req.body.from_session);
          if (!sender) throw httpError(400, "from_session not found");
          if (sender.id === req.body.to_session) {
            throw httpError(400, "from_session and to_session must differ");
          }
          from = sender.id; // speak AS this session; do NOT heartbeat it (no fake liveness)
        }
        const prepared = await write(() => {
          if (from === WEB_CONSOLE_ID) heartbeat(db, WEB_CONSOLE_ID);
          const claimed = prepareAsk(db, {
            from_session: from,
            to_session: req.body.to_session,
            question: req.body.question,
          });
          logAudit(db, {
            caller_session: from,
            interface: "http",
            action: "web_ask",
            args: { to_session: req.body.to_session, from_session: from },
            result: { message_id: claimed.message.id },
          });
          return claimed;
        });
        const { message: msg, wake } = await completeAsk(db, prepared);
        return reply.send({ message: msg, wake });
      } catch (err) {
        return sendError(reply, err, WEB_CONSOLE_ID, "web_ask");
      }
    },
  );
}
