import { randomUUID } from "node:crypto";
import { runtimeDescriptor, isPresetRuntime } from "../../core/runtime-registry.js";
import { getManagedBindingBySession } from "../../core/managed-codex/store.js";
import type { FastifyInstance } from "fastify";
import {
  registerSession,
  listSessions,
  searchSessions,
  sessionBusy,
  getSession,
  heartbeat,
} from "../../core/sessions.js";
import { getTerminalSettings } from "../../core/app-settings.js";
import { openInTerminal, resumeCommand, cleanTerminalEnv } from "../../core/terminal.js";
import { logAudit } from "../../core/audit.js";
import type { ServerContext } from "../context.js";

interface RegisterBody {
  name: string;
  description?: string;
  session_id?: string;
}

export function registerSessionRoutes(app: FastifyInstance, ctx: ServerContext, openTerminal: typeof openInTerminal = openInTerminal): void {
  const { db, audit, sendError, sendHttpError, write } = ctx;
  // The resumed terminal's hooks/MCP must register against THIS server's
  // database; without the explicit home a custom data dir would be lost and
  // the terminal session would silently land in the default database.
  const terminalEnv = { ...cleanTerminalEnv(), CONFLUX_HOME: ctx.dataDir };

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
      const sid = req.body.session_id || (req.headers["x-session-id"] as string) || randomUUID();
      try {
        const session = await write(() => {
          const created = registerSession(db, {
            id: sid,
            name: req.body.name,
            description: req.body.description ?? null,
            project_dir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
          });
          audit(sid, "register_session", { name: req.body.name }, { session_id: sid });
          return created;
        });
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

  // GET /sessions/search?q= — capability discovery (name/description/skills)
  app.get<{ Querystring: { q?: string } }>("/sessions/search", {}, async (req, reply) => {
    try {
      const q = (req.query.q as string | undefined) ?? "";
      const sessions = searchSessions(db, q);
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
      // The managed executor retains thread ownership after stopping; an
      // external terminal would bypass its single-writer recovery checks.
      if (getManagedBindingBySession(db, id)) {
        return sendHttpError(reply, 409, "managed conversations must use the managed runtime controls");
      }
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(session.metadata ?? "{}") as Record<string, unknown>; }
      catch { /* Historical sessions may have malformed metadata. */ }
      const runtime = session.runtime ? session.runtime : (typeof meta.runtime === "string" ? meta.runtime : "claude");
      if (!isPresetRuntime(runtime)) return sendHttpError(reply, 400, "unsupported session runtime");
      const descriptor = runtimeDescriptor(runtime);
      const settings = getTerminalSettings(db);
      const executable = descriptor.settingsKey ? settings[descriptor.settingsKey] :
        process.env[descriptor.executableEnv] || descriptor.executable;
      const nativeId = runtime === "codex"
        ? meta.codex_session_id
        : id;
      if (typeof nativeId !== "string" || !nativeId) return sendHttpError(reply, 400, "native conversation id is missing");
      const result = openTerminal(settings, {
        command: resumeCommand(runtime, nativeId, executable),
        cwd: session.project_dir ?? undefined,
        title: `Conflux · ${session.name}`,
        env: terminalEnv,
      });
      await write(() => {
        heartbeat(db, id);
        logAudit(db, {
          interface: "http",
          action: "open_terminal",
          args: { session: id, runtime },
          result,
        });
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
