import type { FastifyInstance } from "fastify";
import type { ApprovalMode, RuntimeId, RuntimeSettings, WorkspaceTreeResponse } from "@conflux/shared";
import { APP_VERSION } from "../../version.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  searchProjectFiles,
} from "../../core/projects.js";
import { createTemplate, deleteTemplate, listTemplates } from "../../core/templates.js";
import { clearCliProbeCache, probeLocalClis } from "../../core/cli-probe.js";
import { getRuntimeSettings, saveRuntimeSettings } from "../../core/runtime-env.js";
import { listRooms } from "../../core/rooms.js";
import { listWorkflows } from "../../core/workflows.js";
import { listPendingThreadApprovals, listThreads } from "../../core/threads/store.js";
import { getThreadManager } from "../../core/threads/executor.js";
import { buildGraph } from "../../core/graph.js";
import { resourceId, type ServerContext } from "../context.js";

export function registerProjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendHttpError, write } = ctx;

  app.get("/healthz", async (_req, reply) =>
    reply.send({ ok: true, version: APP_VERSION, schema: "v2" }),
  );

  app.get("/workspace/tree", async (_req, reply) => {
    const manager = getThreadManager();
    const threads = manager ? manager.listDecoratedThreads() : listThreads(db);
    const tree: WorkspaceTreeResponse = {
      projects: listProjects(db),
      threads,
      rooms: listRooms(db),
      workflows: listWorkflows(db),
      pending_approvals: listPendingThreadApprovals(db),
      cli_probes: probeLocalClis(db),
    };
    return reply.send(tree);
  });

  app.get("/graph", async (_req, reply) => reply.send(buildGraph(db)));

  app.get<{ Querystring: { refresh?: string } }>("/runtimes/probe", async (req, reply) => {
    const force = req.query.refresh === "1" || req.query.refresh === "true";
    return reply.send({ runtimes: probeLocalClis(db, { force }) });
  });

  app.get("/settings", async (_req, reply) => reply.send({ settings: getRuntimeSettings(db) }));

  app.put<{ Body: Partial<RuntimeSettings> }>("/settings", async (req, reply) => {
    const settings = await write(() => saveRuntimeSettings(db, req.body ?? {}));
    clearCliProbeCache();
    return reply.send({ settings });
  });

  // ---- Projects ----

  app.get("/projects", async (_req, reply) => reply.send({ projects: listProjects(db) }));

  app.post<{ Body: { root_path: string; name?: string } }>("/projects", async (req, reply) => {
    const project = await write(() => createProject(db, req.body));
    return reply.code(201).send({ project });
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    const ok = await write(() => deleteProject(db, resourceId(req.params.id)));
    if (!ok) return sendHttpError(reply, 404, "project not found");
    return reply.send({ ok: true });
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    "/projects/:id/files",
    async (req, reply) => {
      const project = getProject(db, resourceId(req.params.id));
      if (!project) return sendHttpError(reply, 404, "project not found");
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      return reply.send({ files: searchProjectFiles(project.root_path, req.query.q ?? "", limit) });
    },
  );

  // ---- Lightweight Agent Templates ----

  app.get("/templates", async (_req, reply) => reply.send({ templates: listTemplates(db) }));

  app.post<{
    Body: {
      name: string;
      runtime: RuntimeId;
      model?: string | null;
      instructions?: string | null;
      extra_env?: string | null;
      approval_mode?: ApprovalMode;
      use_worktree?: boolean;
    };
  }>("/templates", async (req, reply) => {
    const template = await write(() => createTemplate(db, req.body));
    return reply.code(201).send({ template });
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", async (req, reply) => {
    const ok = await write(() => deleteTemplate(db, resourceId(req.params.id)));
    if (!ok) return sendHttpError(reply, 404, "template not found");
    return reply.send({ ok: true });
  });
}
