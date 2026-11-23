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
import { logAudit } from "../../core/audit.js";

/**
 * HTTP surface for multi-agent DAG workflows and cross-session context handoff.
 */
export function registerWorkflowRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, sendError, sendHttpError, write } = ctx;

  app.get<{ Querystring: { room_id?: string } }>("/workflows", {}, async (req, reply) => {
    try {
      const roomId = req.query.room_id ? resourceId(req.query.room_id) : undefined;
      return reply.send({ workflows: listWorkflows(db, roomId) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/workflows/:id", {}, async (req, reply) => {
    try {
      const workflow = getWorkflow(db, resourceId(req.params.id));
      if (!workflow) return sendHttpError(reply, 404, "workflow not found");
      return reply.send({ workflow });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      name: string;
      description?: string | null;
      room_id?: number | null;
      steps: WorkflowStepDefinition[];
    };
  }>("/workflows", {}, async (req, reply) => {
    try {
      const workflow = await write(() => {
        const created = createWorkflow(db, req.body);
        logAudit(db, {
          interface: "http",
          action: "create_workflow",
          args: { name: created.name, room_id: created.room_id, steps: created.steps.length },
          result: { id: created.id },
        });
        return created;
      });
      return reply.status(201).send({ workflow });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/workflows/:id", {}, async (req, reply) => {
    try {
      const ok = await write(() => deleteWorkflow(db, resourceId(req.params.id)));
      if (!ok) return sendHttpError(reply, 404, "workflow not found");
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Params: { id: string };
    Body: { input?: string; room_id?: number | null };
  }>("/workflows/:id/runs", {}, async (req, reply) => {
    try {
      const sid = requireSession(req);
      const run = await startWorkflowRun(db, resourceId(req.params.id), {
        input: req.body?.input,
        room_id: req.body?.room_id,
        initiated_by: sid,
      });
      return reply.status(201).send({ run });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { room_id?: string; workflow_id?: string; limit?: string } }>(
    "/workflow-runs",
    {},
    async (req, reply) => {
      try {
        const runs = listWorkflowRuns(db, {
          roomId: req.query.room_id ? resourceId(req.query.room_id) : undefined,
          workflowId: req.query.workflow_id ? resourceId(req.query.workflow_id) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        return reply.send({ runs });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { runId: string } }>("/workflow-runs/:runId", {}, async (req, reply) => {
    try {
      const run = getWorkflowRun(db, resourceId(req.params.runId));
      if (!run) return sendHttpError(reply, 404, "workflow run not found");
      return reply.send({ run });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/workflow-runs/:runId/cancel", {}, async (req, reply) => {
    try {
      const run = await write(() => cancelWorkflowRun(db, resourceId(req.params.runId)));
      if (!run) return sendHttpError(reply, 404, "workflow run not found");
      return reply.send({ run });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Params: { stepId: string };
    Body: { approved: boolean; comment?: string };
  }>("/workflow-steps/:stepId/approve", {}, async (req, reply) => {
    try {
      const sid = requireSession(req);
      if (sid !== WEB_CONSOLE_ID) {
        return sendHttpError(reply, 403, "human_gate approvals are answered by the user console only");
      }
      const run = await approveHumanGate(db, resourceId(req.params.stepId), {
        approved: Boolean(req.body?.approved),
        comment: req.body?.comment,
      });
      return reply.send({ run });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Params: { stepId: string };
    Body: { status?: "done" | "failed"; output?: string; error?: string };
  }>("/workflow-steps/:stepId/complete", {}, async (req, reply) => {
    try {
      const run = await completeWorkflowStep(db, resourceId(req.params.stepId), {
        status: req.body?.status,
        output: req.body?.output,
        error: req.body?.error,
      });
      return reply.send({ run });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      from_session?: string;
      from_sessions?: string[];
      to_session: string;
      room_id?: number | null;
      title?: string;
      note?: string;
      prompt?: string;
      max_chars?: number;
      delivery_mode?: ManagedDeliveryMode;
      deliver?: boolean;
    };
  }>("/handoff", {}, async (req, reply) => {
    try {
      const caller = requireSession(req);
      if (!req.body?.to_session) {
        return sendHttpError(reply, 400, "to_session is required");
      }
      const result = await handoffContext(db, {
        from_session: req.body.from_session || caller,
        from_sessions: req.body.from_sessions,
        to_session: req.body.to_session,
        room_id: req.body.room_id,
        title: req.body.title,
        note: req.body.note,
        prompt: req.body.prompt,
        max_chars: req.body.max_chars,
        delivery_mode: req.body.delivery_mode,
        deliver: req.body.deliver,
      });
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
