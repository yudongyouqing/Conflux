import type { FastifyInstance } from "fastify";
import type { ManagedDeliveryMode, WorkflowStepDefinition } from "@conflux/shared";
import { resourceId, WEB_CONSOLE_ID, type ServerContext } from "../context.js";
import {
  approveHumanGate,
  cancelWorkflowRun,
  completeWorkflowStep,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflows,
  startWorkflowRun,
} from "../../core/workflows.js";
import { handoffContext } from "../../core/handoff.js";

export function registerWorkflowRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, sendHttpError, write } = ctx;

  app.get<{ Querystring: { project_id?: string; room_id?: string } }>(
    "/workflows",
    async (req, reply) => {
      const project_id =
        req.query.project_id === "global"
          ? null
          : req.query.project_id
            ? resourceId(req.query.project_id)
            : undefined;
      const room_id = req.query.room_id ? resourceId(req.query.room_id) : undefined;
      return reply.send({ workflows: listWorkflows(db, { project_id, room_id }) });
    },
  );

  app.get<{ Params: { id: string } }>("/workflows/:id", async (req, reply) => {
    const workflow = getWorkflow(db, resourceId(req.params.id));
    if (!workflow) return sendHttpError(reply, 404, "workflow not found");
    return reply.send({ workflow });
  });

  app.post<{
    Body: {
      name: string;
      description?: string | null;
      project_id?: number | null;
      room_id?: number | null;
      steps: WorkflowStepDefinition[];
    };
  }>("/workflows", async (req, reply) => {
    const workflow = await write(() => createWorkflow(db, req.body));
    return reply.code(201).send({ workflow });
  });

  app.delete<{ Params: { id: string } }>("/workflows/:id", async (req, reply) => {
    const ok = await write(() => deleteWorkflow(db, resourceId(req.params.id)));
    if (!ok) return sendHttpError(reply, 404, "workflow not found");
    return reply.send({ ok: true });
  });

  app.post<{
    Params: { id: string };
    Body: { input?: string; project_id?: number | null; room_id?: number | null };
  }>("/workflows/:id/runs", async (req, reply) => {
    const run = await startWorkflowRun(db, resourceId(req.params.id), {
      input: req.body?.input,
      project_id: req.body?.project_id,
      room_id: req.body?.room_id,
      initiated_by: requireSession(req),
    });
    return reply.code(201).send({ run });
  });

  app.get<{
    Querystring: { project_id?: string; room_id?: string; workflow_id?: string; limit?: string };
  }>("/workflow-runs", async (req, reply) => {
    const runs = listWorkflowRuns(db, {
      project_id: req.query.project_id ? resourceId(req.query.project_id) : undefined,
      room_id: req.query.room_id ? resourceId(req.query.room_id) : undefined,
      workflow_id: req.query.workflow_id ? resourceId(req.query.workflow_id) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return reply.send({ runs });
  });

  app.get<{ Params: { runId: string } }>("/workflow-runs/:runId", async (req, reply) => {
    const run = getWorkflowRun(db, resourceId(req.params.runId));
    if (!run) return sendHttpError(reply, 404, "workflow run not found");
    return reply.send({ run });
  });

  app.post<{ Params: { runId: string } }>("/workflow-runs/:runId/cancel", async (req, reply) => {
    const run = await write(() => cancelWorkflowRun(db, resourceId(req.params.runId)));
    if (!run) return sendHttpError(reply, 404, "workflow run not found");
    return reply.send({ run });
  });

  app.post<{
    Params: { stepId: string };
    Body: { approved: boolean; comment?: string };
  }>("/workflow-steps/:stepId/approve", async (req, reply) => {
    if (requireSession(req) !== WEB_CONSOLE_ID) {
      return sendHttpError(reply, 403, "human_gate approvals are answered by the user console only");
    }
    const run = await approveHumanGate(db, resourceId(req.params.stepId), {
      approved: Boolean(req.body?.approved),
      comment: req.body?.comment,
    });
    return reply.send({ run });
  });

  app.post<{
    Params: { stepId: string };
    Body: { status?: "done" | "failed"; output?: string; error?: string };
  }>("/workflow-steps/:stepId/complete", async (req, reply) => {
    const run = await completeWorkflowStep(db, resourceId(req.params.stepId), {
      status: req.body?.status,
      output: req.body?.output,
      error: req.body?.error,
    });
    return reply.send({ run });
  });

  app.post<{
    Body: {
      from_thread?: string;
      from_threads?: string[];
      to_thread: string;
      project_id?: number | null;
      room_id?: number | null;
      title?: string;
      note?: string;
      prompt?: string;
      max_chars?: number;
      delivery_mode?: ManagedDeliveryMode;
      deliver?: boolean;
    };
  }>("/handoff", async (req, reply) => {
    const caller = requireSession(req);
    if (!req.body?.to_thread) {
      return sendHttpError(reply, 400, "to_thread is required");
    }
    const result = await handoffContext(db, {
      from_thread: req.body.from_thread || caller,
      from_threads: req.body.from_threads,
      to_thread: req.body.to_thread,
      project_id: req.body.project_id,
      room_id: req.body.room_id,
      title: req.body.title,
      note: req.body.note,
      prompt: req.body.prompt,
      max_chars: req.body.max_chars,
      delivery_mode: req.body.delivery_mode,
      deliver: req.body.deliver,
    });
    return reply.send(result);
  });
}
