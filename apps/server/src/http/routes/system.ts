import type { FastifyInstance } from "fastify";
import { getGraph } from "../../core/graph.js";
import { queryAudit } from "../../core/audit.js";
import { exportData, importData, type ImportConflictStrategy } from "../../core/data-transfer.js";
import { logAudit } from "../../core/audit.js";
import type { ServerContext } from "../context.js";

interface AuditQs {
  session?: string;
  action?: string;
  interface?: string;
  limit?: string;
}
interface DataExportQs {
  scope?: string;
}
interface DataImportBody {
  bundle: Record<string, unknown>;
  conflict?: string;
}

export function registerSystemRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError, sendHttpError } = ctx;

  // GET /graph — return nodes (sessions) + edges (communication links)
  app.get<{ Querystring: { status?: string } }>("/graph", {}, async (req, reply) => {
    try {
      const status =
        (req.query.status as "active" | "stale" | "ended" | "all" | undefined) ?? "active";
      const graph = getGraph(db, { status });
      return reply.send(graph);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /data/export - portable, secret-free database export
  app.get<{ Querystring: DataExportQs }>("/data/export", {}, async (req, reply) => {
    const scope = parseDataScope(req.query.scope);
    if (!scope) return sendHttpError(reply, 400, "scope must be global or project");
    try {
      const bundle = exportData(db, {
        scope,
        projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      });
      logAudit(db, {
        interface: "http",
        action: "export_data",
        args: { scope },
        result: dataTransferSummary(bundle),
      });
      reply.header("Content-Disposition", 'attachment; filename="conflux-data-v1.json"');
      return reply.send(bundle);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /data/import - validate and import one portable bundle atomically
  app.post<{ Body: DataImportBody }>(
    "/data/import",
    {
      schema: {
        body: {
          type: "object",
          required: ["bundle"],
          additionalProperties: false,
          properties: {
            bundle: { type: "object" },
            conflict: { type: "string", enum: ["skip", "overwrite", "copy"] },
          },
        },
      },
    },
    async (req, reply) => {
      const conflict = req.body.conflict ?? "skip";
      if (!isImportConflictStrategy(conflict)) {
        return sendHttpError(reply, 400, "conflict must be skip, overwrite, or copy");
      }
      try {
        const result = importData(db, req.body.bundle, {
          conflict,
          projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        });
        logAudit(db, {
          interface: "http",
          action: "import_data",
          args: { conflict },
          result: { ...result },
        });
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err, undefined, "import_data", { conflict }, 400);
      }
    },
  );

  // GET /audit
  app.get<{ Querystring: AuditQs }>("/audit", {}, async (req, reply) => {
    try {
      const entries = queryAudit(db, {
        session: req.query.session,
        action: req.query.action,
        iface: req.query.interface as "mcp" | "http" | "cli" | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /healthz
  app.get("/healthz", {}, async (_req, reply) => reply.send({ ok: true }));
}

function parseDataScope(value: string | undefined): "global" | "project" | null {
  if (value === undefined || value === "global") return "global";
  if (value === "project") return "project";
  return null;
}

function isImportConflictStrategy(value: string): value is ImportConflictStrategy {
  return value === "skip" || value === "overwrite" || value === "copy";
}

function dataTransferSummary(bundle: {
  scope: string;
  sessions: unknown[];
  context_entries: unknown[];
  messages: unknown[];
  edges: unknown[];
  agents: unknown[];
  conversations: unknown[];
  turns: unknown[];
  runtime_agents: unknown[];
}): Record<string, unknown> {
  return {
    scope: bundle.scope,
    counts: {
      sessions: bundle.sessions.length,
      context_entries: bundle.context_entries.length,
      messages: bundle.messages.length,
      edges: bundle.edges.length,
      agents: bundle.agents.length,
      conversations: bundle.conversations.length,
      turns: bundle.turns.length,
      runtime_agents: bundle.runtime_agents.length,
    },
  };
}
