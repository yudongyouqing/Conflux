import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { APP_VERSION } from "../version.js";
import { resolveConfig, resolveHttpHost, resolveHttpPort, type Scope } from "../config.js";
import { openDb, stopWalCheckpoint, type DB } from "../core/db.js";
import { logger } from "../log.js";
import { createServerContext, httpError } from "./context.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerRoomAndMemoryRoutes } from "./routes/rooms.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerLiveEventsRoutes } from "./routes/live-events.js";
import { installRoomOrchestrationHooks } from "../core/rooms.js";
import { installWorkflowHooks } from "../core/workflows.js";
import {
  ThreadManager,
  getThreadManager,
  setThreadManager,
  type ThreadManagerOptions,
} from "../core/threads/executor.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  scope?: Scope;
  overrideDataDir?: string;
  threadManagerOptions?: ThreadManagerOptions;
}

const LOCAL_CORS_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return LOCAL_CORS_ORIGIN_RE.test(origin);
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<FastifyInstance> {
  const config = resolveConfig(opts.scope ?? "global", opts.overrideDataDir);
  const db: DB = openDb(config);
  db.pragma("busy_timeout = 50");

  const host = resolveHttpHost(opts.host);
  const port = resolveHttpPort(opts.port);
  const webDist = process.env.CONFLUX_WEB_DIST
    ? resolve(process.env.CONFLUX_WEB_DIST)
    : resolve(__dirname, "../../../web/dist");

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  const threadManager = new ThreadManager(db, opts.threadManagerOptions);
  setThreadManager(threadManager);
  threadManager.startQueuePolling();
  installRoomOrchestrationHooks();
  installWorkflowHooks();

  let resourcesClosed = false;
  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    if (getThreadManager() === threadManager) setThreadManager(null);
    await threadManager.shutdown();
    stopWalCheckpoint(db);
    if (db.open) db.close();
  };
  app.addHook("onClose", async () => {
    await closeResources();
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Conflux v2",
        version: APP_VERSION,
        description: "Project-first multi-agent workbench & orchestration control plane.",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin)),
  });

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: false,
    });
  }

  const ctx = createServerContext(db, { dataDir: config.dataDir, port });
  app.setNotFoundHandler((req, reply) =>
    ctx.sendError(reply, httpError(404, `route not found: ${req.method} ${req.url}`)),
  );
  app.setErrorHandler((err, _req, reply) => {
    if (reply.sent) return;
    return ctx.sendError(reply, err);
  });

  registerProjectRoutes(app, ctx);
  registerThreadRoutes(app, ctx);
  registerRoomAndMemoryRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerLiveEventsRoutes(app);

  try {
    await app.listen({ host, port });
  } catch (err) {
    await closeResources();
    throw err;
  }

  logger.info({ webDist, host, port, dbPath: config.dbPath }, "conflux v2 http server listening");
  return app;
}
