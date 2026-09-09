import type { FastifyInstance } from "fastify";
import {
  checkInbox,
  replyAsk,
  checkReplies,
  listMessages,
  listPeerMessages,
  listEdgeMessages,
  getEdge,
} from "../../core/messages.js";
import { askAndMaybeWake } from "../../core/ask.js";
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
  const { db, requireSession, audit, sendError, sendHttpError } = ctx;

  // POST /messages/ask
  app.post<{ Body: AskBody }>("/messages/ask", {
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
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const { message: msg, wake } = askAndMaybeWake(db, {
        from_session: sid,
        to_session: req.body.to_session,
        question: req.body.question,
      });
      audit(sid, "ask_session", { to_session: req.body.to_session }, { message_id: msg.id, wake });
      return reply.send({ message: msg, wake });
    } catch (err) {
      return sendError(reply, err, sid, "ask_session");
    }
  });

  // GET /messages/inbox
  app.get("/messages/inbox", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const inbox = checkInbox(db, sid);
      audit(sid, "check_inbox", {}, { count: inbox.length });
      return reply.send({ inbox });
    } catch (err) {
      return sendError(reply, err, sid, "check_inbox");
    }
  });

  // POST /messages/:id/reply
  app.post<{ Params: { id: string }; Body: ReplyBody }>("/messages/:id/reply", {
    schema: {
      body: {
        type: "object",
        required: ["reply"],
        properties: {
          reply: { type: "string", maxLength: 20000 },
        },
      },
    },
  }, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const msg = replyAsk(db, Number(req.params.id), sid, req.body.reply);
      audit(sid, "reply_ask", { id: req.params.id }, { message_id: msg.id });
      return reply.send({ message: msg });
    } catch (err) {
      return sendError(reply, err, sid, "reply_ask");
    }
  });

  // GET /messages/replies
  app.get<{ Querystring: { since?: string } }>("/messages/replies", {}, async (req, reply) => {
    const sid = requireSession(req);
    try {
      const replies = checkReplies(db, sid, req.query.since);
      audit(sid, "check_replies", { since: req.query.since }, { count: replies.length });
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
  app.get<{ Querystring: { a?: string; b?: string } }>("/messages/peers", {}, async (req, reply) => {
    const { a, b } = req.query;
    if (!a || !b) return sendHttpError(reply, 400, "missing a/b query params");
    try {
      const messages = listPeerMessages(db, a, b);
      return reply.send({ messages });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- edge channels (directed conversation channels) ----

  // GET /edges/:id/messages — the channel's exchange history
  app.get<{ Params: { id: string } }>("/edges/:id/messages", {}, async (req, reply) => {
    try {
      const edgeId = Number(req.params.id);
      const edge = getEdge(db, edgeId);
      if (!edge) return sendHttpError(reply, 404, "edge not found");
      return reply.send({
        edge: { id: edge.id, from: edge.from_session, to: edge.to_session },
        messages: listEdgeMessages(db, edgeId),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /edges/:id/ask — speak ON the channel (web console may only use
  // channels it initiated: edge.from === web-console)
  app.post<{ Params: { id: string }; Body: { question: string } }>("/edges/:id/ask", {
    schema: {
      body: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string", maxLength: 20000 } },
      },
    },
  }, async (req, reply) => {
    try {
      const edgeId = Number(req.params.id);
      const edge = getEdge(db, edgeId);
      if (!edge) return sendHttpError(reply, 404, "edge not found");
      if (edge.from_session !== WEB_CONSOLE_ID) {
        return sendHttpError(
          reply,
          403,
          `只读通道:${edge.from_session} 发起的对话只能由该会话发言`
        );
      }

      heartbeat(db, WEB_CONSOLE_ID);
      const { message: msg, wake } = askAndMaybeWake(db, {
        from_session: WEB_CONSOLE_ID,
        to_session: edge.to_session,
        question: req.body.question,
      });
      logAudit(db, {
        caller_session: WEB_CONSOLE_ID,
        interface: "http",
        action: "edge_ask",
        args: { edge: edgeId },
        result: { message_id: msg.id, wake },
      });
      return reply.send({ message: msg, wake });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "edge_ask");
    }
  });

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
  app.post<{ Body: { to_session: string; question: string; from_session?: string } }>("/web/ask", {
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
  }, async (req, reply) => {
    try {
      let from = WEB_CONSOLE_ID;
      if (req.body.from_session && req.body.from_session !== WEB_CONSOLE_ID) {
        const sender = getSession(db, req.body.from_session);
        if (!sender) throw httpError(400, "from_session not found");
        if (sender.id === req.body.to_session) {
          throw httpError(400, "from_session and to_session must differ");
        }
        from = sender.id; // speak AS this session; do NOT heartbeat it (no fake liveness)
      } else {
        heartbeat(db, WEB_CONSOLE_ID);
      }
      const { message: msg, wake } = askAndMaybeWake(db, {
        from_session: from,
        to_session: req.body.to_session,
        question: req.body.question,
      });
      logAudit(db, {
        caller_session: from,
        interface: "http",
        action: "web_ask",
        args: { to_session: req.body.to_session, from_session: from },
        result: { message_id: msg.id, wake },
      });
      return reply.send({ message: msg, wake });
    } catch (err) {
      return sendError(reply, err, WEB_CONSOLE_ID, "web_ask");
    }
  });
}
