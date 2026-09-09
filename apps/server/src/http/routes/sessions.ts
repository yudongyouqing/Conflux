import type { FastifyInstance } from "fastify";
import {
  registerSession,
  listSessions,
  sessionBusy,
  getSession,
  heartbeat,
} from "../../core/sessions.js";
import { getTerminalSettings } from "../../core/app-settings.js";
import { openInTerminal, resumeCommand } from "../../core/terminal.js";
import { logAudit } from "../../core/audit.js";
import type { ServerContext } from "../context.js";

interface RegisterBody {
  name: string;
  description?: string;
  session_id?: string;
}

// Minimal UUIDv4 (avoids an extra dependency for one call site).
function uuidv4(): string {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function registerSessionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, audit, sendError, sendHttpError } = ctx;

  // POST /sessions/register
  app.post<{ Body: RegisterBody }>(
    "/sessions/register",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", maxLength: 200 },
            description: { type: "string", maxLength: 2000 },
            session_id: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const sid = req.body.session_id || (req.headers["x-session-id"] as string) || uuidv4();
      try {
        const session = registerSession(db, {
          id: sid,
          name: req.body.name,
          description: req.body.description ?? null,
          project_dir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        });
        audit(sid, "register_session", { name: req.body.name }, { session_id: sid });
        reply.header("X-Session-Id", sid);
        return reply.send({ session_id: sid, session });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // GET /sessions
  app.get<{ Querystring: { status?: string } }>("/sessions", {}, async (req, reply) => {
    try {
      const status =
        (req.query.status as "active" | "stale" | "ended" | "all" | undefined) ?? "active";
      const sessions = listSessions(db, { status }).map((s) => ({
        ...s,
        busy: sessionBusy(s.metadata),
      }));
      return reply.send({ sessions });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /sessions/:id/open-terminal — open the session's conversation in a
  // new terminal window (claude --resume <id> / codex resume <id>)
  app.post<{ Params: { id: string } }>("/sessions/:id/open-terminal", {}, async (req, reply) => {
    try {
      const id = req.params.id;
      const session = getSession(db, id);
      if (!session) return sendHttpError(reply, 404, "session not found");
      if (id.startsWith("agent-")) {
        return sendHttpError(reply, 400, "internal agents have no terminal");
      }
      let runtime: "claude" | "codex" = "claude";
      try {
        const meta = session.metadata
          ? (JSON.parse(session.metadata) as Record<string, unknown>)
          : null;
        if (meta?.runtime === "codex") runtime = "codex";
      } catch {
        // malformed metadata — default runtime
      }
      const settings = getTerminalSettings(db);
      const executable = runtime === "codex" ? settings.codex_path : settings.claude_path;
      const result = openInTerminal(settings, {
        command: resumeCommand(runtime, id, executable),
        cwd: session.project_dir ?? undefined,
        title: `muiltchat · ${session.name}`,
      });
      heartbeat(db, id);
      logAudit(db, {
        interface: "http",
        action: "open_terminal",
        args: { session: id, runtime },
        result,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
