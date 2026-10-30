import type { FastifyInstance } from "fastify";
import {
  RUNTIMES,
  createRuntimeAgent,
  deleteRuntimeAgent,
  listRuntimeAgentsWithLiveness,
  startRuntimeAgent,
} from "../../core/runtime-agents.js";
import { logAudit } from "../../core/audit.js";
import { RUNTIME_IDS } from "../../core/runtime-registry.js";
import { WEB_CONSOLE_ID, type ServerContext } from "../context.js";
import {
  listRuntimeInstances,
  stopRuntimeInstance,
  resumeRuntimeInstance,
  type RuntimeProcessIO,
} from "../../core/runtime-instances.js";
import type { StartRuntimeOptions } from "../../core/runtime-agents.js";

interface RuntimeAgentBody {
  name: string;
  runtime: string;
  workdir?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  instructions?: string;
  interval_min?: number | null;
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  io: StartRuntimeOptions & RuntimeProcessIO = {},
): void {
  const { db, sendError, sendHttpError } = ctx;

  app.get("/runtime-instances", {}, async (_req, reply) => {
    try {
      return reply.send({ instances: listRuntimeInstances(db, io) });
    } catch (error) {
      return sendError(reply, error);
    }
  });
  for (const action of ["stop", "resume"] as const) {
    app.post<{ Params: { id: string } }>(
      `/runtime-instances/:id/${action}`,
      {},
      async (req, reply) => {
        try {
          const result =
            action === "stop"
              ? { instance: stopRuntimeInstance(db, req.params.id, io) }
              : resumeRuntimeInstance(db, req.params.id, io);
          logAudit(db, {
            interface: "http",
            action: `${action}_runtime_instance`,
            args: { id: req.params.id },
            result: { instance_id: result.instance.id, state: result.instance.state },
          });
          return reply.send(result);
        } catch (error) {
          return sendError(reply, error, WEB_CONSOLE_ID, `${action}_runtime_instance`, {
            id: req.params.id,
          });
        }
      },
    );
  }

  // ---- runtime agents (user-defined CLI agent presets: Claude Code / Codex) ----

  // GET /runtimes — catalog (supported CLIs) + configured presets
  app.get("/runtimes", {}, async (_req, reply) => {
    try {
      return reply.send({
        runtimes: RUNTIMES,
        agents: listRuntimeAgentsWithLiveness(db),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: RuntimeAgentBody }>(
    "/runtimes",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "runtime"],
          properties: {
            name: { type: "string", maxLength: 100 },
            runtime: { type: "string", enum: RUNTIME_IDS },
            workdir: { type: "string", maxLength: 1000 },
            model: { type: "string", maxLength: 200 },
            base_url: { type: "string", maxLength: 1000 },
            api_key: { type: "string", maxLength: 500 },
            extra_env: { type: "string", maxLength: 10000 },
            instructions: { type: "string", maxLength: 20000 },
            interval_min: { type: "integer", minimum: 1, maximum: 10080 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = createRuntimeAgent(db, req.body);
        logAudit(db, {
          interface: "http",
          action: "create_runtime_agent",
          args: { id: agent.id, runtime: agent.runtime },
        });
        return reply.code(201).send({ agent });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/runtimes/:id", {}, async (req, reply) => {
    try {
      const ok = deleteRuntimeAgent(db, Number(req.params.id));
      if (!ok) return sendHttpError(reply, 404, "runtime agent not found");
      logAudit(db, {
        interface: "http",
        action: "delete_runtime_agent",
        args: { id: req.params.id },
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /runtimes/:id/start — launch the preset in a new terminal window
  app.post<{ Params: { id: string } }>("/runtimes/:id/start", {}, async (req, reply) => {
    try {
      const result = startRuntimeAgent(db, Number(req.params.id), io);
      logAudit(db, {
        interface: "http",
        action: "start_runtime_agent",
        args: { id: req.params.id },
        result,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
