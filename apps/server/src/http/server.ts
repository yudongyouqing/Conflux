import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "fs";
import { resolve } from "path";

import {
  resolveConfig,
  resolveHttpHost,
  resolveHttpPort,
  type Scope,
} from "../config.js";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import {
  registerSession,
  heartbeat,
  markStaleSessions,
  pruneAbandonedSessions,
  getSession,
} from "../core/sessions.js";
import { getContext } from "../core/context.js";
import { getMessage } from "../core/messages.js";
import { tickScheduledAgents } from "../core/runtime-agents.js";
import { probeRuntimePids, reconcileRuntimeLiveness, type RuntimePidSnapshot } from "../core/liveness.js";
import { expireMcpLeases } from "../core/mcp-liveness.js";
import { refreshCodexSessionTitles } from "../core/codex-titles.js";
import { logger } from "../log.js";
import { createServerContext, httpError, WEB_CONSOLE_ID } from "./context.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerRuntimeRoutes } from "./routes/runtimes.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSystemRoutes } from "./routes/system.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  scope?: Scope;
  overrideDataDir?: string;
}

export type RuntimePidProbe = () => Promise<RuntimePidSnapshot | null>;

export async function reconcileRuntimeState(
  db: DB,
  probe: RuntimePidProbe = probeRuntimePids,
  now: Date = new Date()
): Promise<{ expired: number; refreshed: number; reaped: number }> {
  const { expired } = expireMcpLeases(db, now);
  const livePids = await probe();
  if (!livePids) return { expired, refreshed: 0, reaped: 0 };
  const { refreshed, reaped } = reconcileRuntimeLiveness(db, livePids, now);
  return { expired, refreshed, reaped };
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db: DB = openDb(config);
  const host = resolveHttpHost(opts.host);
  const port = resolveHttpPort(opts.port);
  const webDist = process.env.MUILTCHAT_WEB_DIST
    ? resolve(process.env.MUILTCHAT_WEB_DIST)
    : resolve(__dirname, "../../../web/dist");

  // ---- Web console identity ----
  // The browser UI acts as one fixed pseudo-session, so Drawer-originated
  // asks have a stable FK target and appear in the graph as a single node.
  registerSession(db, {
    id: WEB_CONSOLE_ID,
    name: "Web 控制台",
    description: "浏览器界面身份(从会话详情抽屉发起的对话)",
  });
  const consoleBeat = setInterval(() => {
    try {
      heartbeat(db, WEB_CONSOLE_ID);
    } catch {
      // transient sqlite lock — next tick retries
    }
  }, 30_000);
  consoleBeat.unref();

  // ---- zero-turn session reaper ----
  // Sessions abandoned mid-startup (open claude → immediately /resume) and
  // dead MCP temp placeholders go stale; sweep them out of the DB so the
  // graph doesn't accumulate zombie nodes.
  const sweepAbandoned = () => {
    try {
      markStaleSessions(db);
      pruneAbandonedSessions(db);
    } catch {
      // transient sqlite lock — next tick retries
    }
  };
  sweepAbandoned();
  const abandonedSweep = setInterval(sweepAbandoned, 60_000);
  abandonedSweep.unref();

  // ---- scheduled runtime agents (patrol pattern) ----
  // Every 30s: launch due, non-overlapping scheduled presets headless.
  const scheduleTick = () => {
    try {
      tickScheduledAgents(db);
    } catch {
      // transient sqlite lock — next tick retries
    }
  };
  const scheduleTimer = setInterval(scheduleTick, 30_000);
  scheduleTimer.unref();

  // ---- liveness probe (AgentRecall-style process scan) ----
  // MCP lease sessions are governed by connection heartbeats and lease TTL;
  // legacy rows without a lease are reconciled by runtime PID probing. If the
  // probe fails, the legacy heartbeat TTL remains the fallback.
  const livenessTick = async () => {
    try {
      await reconcileRuntimeState(db);
      // covers codex rows whose MCP child died but whose process still runs
      refreshCodexSessionTitles(db);
    } catch {
      // transient — next tick retries
    }
  };
  const livenessTimer = setInterval(livenessTick, 30_000);
  livenessTimer.unref();

  const app = Fastify({
    logger: false, // we use our own pino sink writing to stderr
  });

  const closeResources = () => {
    clearInterval(consoleBeat);
    clearInterval(abandonedSweep);
    clearInterval(scheduleTimer);
    clearInterval(livenessTimer);
    stopWalCheckpoint(db);
    if (db.open) db.close();
  };
  app.addHook("onClose", async () => {
    closeResources();
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "muiltchat",
        version: "0.1.0",
        description:
          "Cross-session context query and async messaging for AI coding assistants.",
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // CORS — allow the Vite dev server (and any local client) to call the API.
  await app.register(cors, { origin: true });

  // Serve the built frontend when either the packaged or repository path exists.
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: false,
    });
    logger.info({ webDist }, "serving frontend static files");
  }

  const ctx = createServerContext(db, { dataDir: config.dataDir, port });

  app.setNotFoundHandler((req, reply) =>
    ctx.sendError(reply, httpError(404, `route not found: ${req.method} ${req.url}`))
  );
  app.setErrorHandler((err, _req, reply) => {
    if (reply.sent) return;
    return ctx.sendError(reply, err);
  });

  registerSessionRoutes(app, ctx);
  registerContextRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerSystemRoutes(app, ctx);

  try {
    await app.listen({ host, port });
  } catch (err) {
    closeResources();
    throw err;
  }
  logger.info(
    { webDist, host, port, dataDir: config.dataDir },
    "http server listening"
  );

  return app;
}

// Re-export for completeness.
export { getContext, getMessage, getSession };
