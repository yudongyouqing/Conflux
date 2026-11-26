import type { FastifyInstance } from "fastify";
import type {
  ApprovalMode,
  ManagedDeliveryMode,
  RuntimeId,
  WorkspaceCreateMode,
} from "@conflux/shared";
import { getProject, searchProjectFiles } from "../../core/projects.js";
import {
  commitGitChanges,
  createWorktreePr,
  getCurrentBranch,
  getGitDiff,
  getGitStatus,
  getPrDetail,
  mergeGitPr,
  mergeWorktreeBack,
  pushGitBranch,
  stageGitFiles,
} from "../../core/git-worktree.js";
import {
  detectLocalPreviewUrls,
  execWorkspaceCommand,
  listWorkspaceDirectory,
  readWorkspaceFile,
} from "../../core/workspace-tools.js";
import {
  getThread,
  listPendingThreadApprovals,
  listThreadEvents,
  listThreads,
  updateThread,
} from "../../core/threads/store.js";
import { getThreadManager } from "../../core/threads/executor.js";
import { publishLiveEvent } from "../../core/event-bus.js";
import { resourceId, WEB_CONSOLE_ID, type ServerContext } from "../context.js";

export function registerThreadRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, requireSession, sendHttpError } = ctx;

  const requireManager = () => {
    const manager = getThreadManager();
    if (!manager) {
      throw Object.assign(new Error("thread executor unavailable"), { statusCode: 503 });
    }
    return manager;
  };

  app.get<{ Querystring: { project_id?: string; kind?: "managed" | "external" } }>(
    "/threads",
    async (req, reply) => {
      const manager = getThreadManager();
      const opts = {
        ...(req.query.project_id ? { project_id: resourceId(req.query.project_id) } : {}),
        ...(req.query.kind ? { kind: req.query.kind } : {}),
      };
      const threads = manager ? manager.listDecoratedThreads(opts) : listThreads(db, opts);
      return reply.send({ threads });
    },
  );

  app.post<{
    Body: {
      project_id?: number | null;
      workdir?: string;
      name?: string;
      runtime: RuntimeId;
      model?: string | null;
      instructions?: string | null;
      extra_env?: string | null;
      approval_mode?: ApprovalMode;
      use_worktree?: boolean;
      workspace_mode?: WorkspaceCreateMode;
      branch_name?: string | null;
      pr_number?: number | string | null;
      initial_prompt?: string | null;
    };
  }>("/threads", async (req, reply) => {
    const thread = await requireManager().createAndStartThread(req.body);
    return reply.code(201).send({ thread });
  });

  app.get<{ Params: { id: string } }>("/threads/:id", async (req, reply) => {
    const detail = requireManager().getThreadDetail(req.params.id);
    if (!detail) return sendHttpError(reply, 404, "thread not found");
    return reply.send(detail);
  });

  app.delete<{ Params: { id: string }; Querystring: { remove_worktree?: string } }>(
    "/threads/:id",
    async (req, reply) => {
      const ok = await requireManager().deleteThread(req.params.id, {
        removeWorktree: req.query.remove_worktree === "1" || req.query.remove_worktree === "true",
      });
      if (!ok) return sendHttpError(reply, 404, "thread not found");
      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/threads/:id/events",
    async (req, reply) => {
      if (!getThread(db, req.params.id)) return sendHttpError(reply, 404, "thread not found");
      const after = req.query.after ? Number(req.query.after) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : 400;
      const events = listThreadEvents(db, req.params.id, Number.isFinite(after) ? after : 0, limit);
      return reply.send({ events });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { prompt: string; delivery_mode?: ManagedDeliveryMode; room_id?: number | null };
  }>("/threads/:id/prompt", async (req, reply) => {
    if (!req.body?.prompt?.trim()) return sendHttpError(reply, 400, "prompt is required");
    const res = await requireManager().enqueuePrompt(req.params.id, {
      prompt: req.body.prompt.trim(),
      deliveryMode: req.body.delivery_mode,
      roomId: req.body.room_id ?? null,
    });
    return reply.send(res);
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/threads/:id/steer",
    async (req, reply) => {
      if (!req.body?.text?.trim()) return sendHttpError(reply, 400, "text is required");
      return reply.send(await requireManager().steer(req.params.id, req.body.text.trim()));
    },
  );

  app.post<{ Params: { id: string } }>("/threads/:id/interrupt", async (req, reply) =>
    reply.send(await requireManager().interrupt(req.params.id)),
  );

  app.post<{ Params: { id: string } }>("/threads/:id/stop", async (req, reply) =>
    reply.send({ thread: await requireManager().stopThread(req.params.id) }),
  );

  app.post<{ Params: { id: string } }>("/threads/:id/resume", async (req, reply) =>
    reply.send({ thread: await requireManager().resumeThread(req.params.id) }),
  );

  app.post<{ Params: { id: string }; Body: { model: string } }>(
    "/threads/:id/model",
    async (req, reply) =>
      reply.send(await requireManager().switchModel(req.params.id, req.body?.model ?? "")),
  );

  app.post<{ Params: { id: string }; Body: { approval_mode: ApprovalMode } }>(
    "/threads/:id/approval-mode",
    async (req, reply) => {
      const mode = req.body?.approval_mode === "auto" ? "auto" : "ask";
      return reply.send({ thread: requireManager().setApprovalMode(req.params.id, mode) });
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      target_runtime: RuntimeId;
      model?: string | null;
      name?: string;
      prompt?: string;
      approval_mode?: ApprovalMode;
    };
  }>("/threads/:id/fork-handoff", async (req, reply) =>
    reply.send(await requireManager().forkAndHandoff(req.params.id, req.body)),
  );

  app.post<{
    Params: { id: string; approvalId: string };
    Body: { decision: string; option_id?: string; answers?: Record<string, string | string[]> };
  }>("/threads/:id/approvals/:approvalId", async (req, reply) => {
    if (requireSession(req) !== WEB_CONSOLE_ID) {
      return sendHttpError(reply, 403, "approvals can only be answered by the human console");
    }
    const res = await requireManager().resolveApproval(
      req.params.id,
      resourceId(req.params.approvalId),
      req.body?.decision,
      {
        ...(req.body?.option_id ? { optionId: req.body.option_id } : {}),
        ...(req.body?.answers ? { answers: req.body.answers } : {}),
      },
    );
    if (!res.ok) return sendHttpError(reply, res.status, res.reason);
    return reply.send({ ok: true });
  });

  app.get<{ Querystring: { room_id?: string } }>("/approvals/pending", async (req, reply) => {
    const approvals = listPendingThreadApprovals(db, {
      ...(req.query.room_id ? { roomId: resourceId(req.query.room_id) } : {}),
    });
    return reply.send({ approvals });
  });

  app.post<{ Params: { id: string; checkpointId: string } }>(
    "/threads/:id/checkpoints/:checkpointId/rollback",
    async (req, reply) =>
      reply.send(
        await requireManager().rollbackCheckpoint(req.params.id, resourceId(req.params.checkpointId)),
      ),
  );

  // ---- Files (@ autocomplete scoped to the thread's workdir) & Git ----

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    "/threads/:id/files",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      const limit = req.query.limit ? Number(req.query.limit) : 30;
      return reply.send({ files: searchProjectFiles(thread.workdir, req.query.q ?? "", limit) });
    },
  );

  app.get<{ Params: { id: string } }>("/threads/:id/git/status", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    return reply.send(getGitStatus(thread.workdir, thread.base_branch));
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/threads/:id/git/diff",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      return reply.send(getGitDiff(thread.workdir, req.query.path ?? null));
    },
  );

  app.post<{ Params: { id: string } }>("/threads/:id/git/merge", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    if (!thread.worktree_path || !thread.worktree_branch) {
      return sendHttpError(reply, 400, "该 Agent 直连项目主目录，无需执行 Worktree 分支合并");
    }
    const project = thread.project_id ? getProject(db, thread.project_id) : null;
    if (!project) return sendHttpError(reply, 400, "找不到所属项目目录");
    const targetBranch = thread.base_branch || project.default_branch || "main";
    const result = mergeWorktreeBack(
      project.root_path,
      thread.worktree_path,
      thread.worktree_branch,
      targetBranch,
    );
    if (result.ok) {
      publishLiveEvent({
        type: "git.dirty",
        project_id: project.id,
        thread_id: thread.id,
        payload: { reason: "worktree_merged", result },
      });
    }
    return reply.send(result);
  });

  app.post<{ Params: { id: string }; Body: { paths?: string[]; staged: boolean } }>(
    "/threads/:id/git/stage",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      const status = stageGitFiles(thread.workdir, req.body?.paths ?? null, Boolean(req.body?.staged));
      publishLiveEvent({
        type: "git.dirty",
        project_id: thread.project_id,
        thread_id: thread.id,
        payload: { reason: "staged_updated" },
      });
      return reply.send(status);
    },
  );

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/threads/:id/git/commit",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      const result = commitGitChanges(thread.workdir, req.body?.message ?? "");
      if (result.ok) {
        publishLiveEvent({
          type: "git.dirty",
          project_id: thread.project_id,
          thread_id: thread.id,
          payload: { reason: "committed", result },
        });
      }
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string } }>("/threads/:id/git/push", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    return reply.send(pushGitBranch(thread.workdir));
  });

  app.get<{ Params: { id: string } }>("/threads/:id/git/pr-detail", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    const detail = getPrDetail(thread.workdir, thread.worktree_branch);
    if (detail.pr?.url && detail.pr.url !== thread.pr_url) {
      updateThread(db, thread.id, { pr_url: detail.pr.url });
    }
    return reply.send(detail);
  });

  app.post<{
    Params: { id: string };
    Body: { title?: string; body?: string; draft?: boolean };
  }>("/threads/:id/git/pr", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    const branch = thread.worktree_branch || getCurrentBranch(thread.workdir);
    if (!branch) {
      return sendHttpError(reply, 400, "当前工作区不在有效的 Git 分支上，无法创建 PR");
    }
    const project = thread.project_id ? getProject(db, thread.project_id) : null;
    const targetBranch = thread.base_branch || project?.default_branch || "main";
    const result = createWorktreePr(thread.workdir, branch, targetBranch, req.body ?? {});
    if (result.ok && result.pr_url) {
      const updated = updateThread(db, thread.id, { pr_url: result.pr_url });
      if (updated) {
        publishLiveEvent({
          type: "thread.updated",
          project_id: updated.project_id,
          thread_id: updated.id,
          payload: { action: "pr_linked", thread: requireManager().decorateThread(updated) },
        });
      }
    }
    return reply.send(result);
  });

  app.post<{
    Params: { id: string };
    Body: { method?: "squash" | "merge" | "rebase"; cleanup_worktree?: boolean };
  }>("/threads/:id/git/pr/merge", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    const result = mergeGitPr(thread.workdir, {
      method: req.body?.method ?? "squash",
      deleteBranch: Boolean(thread.worktree_path),
    });
    if (result.ok) {
      if (req.body?.cleanup_worktree && thread.worktree_path) {
        await requireManager().cleanupThreadWorktree(thread.id);
      }
      publishLiveEvent({
        type: "git.dirty",
        project_id: thread.project_id,
        thread_id: thread.id,
        payload: { reason: "pr_merged", result },
      });
    }
    return reply.send(result);
  });

  app.post<{ Params: { id: string } }>("/threads/:id/worktree/cleanup", async (req, reply) =>
    reply.send({ thread: await requireManager().cleanupThreadWorktree(req.params.id) }),
  );

  // ---- Paseo Workspace Tools: Embedded Terminal, File Explorer & Live Preview ----

  app.post<{ Params: { id: string }; Body: { command: string } }>(
    "/threads/:id/terminal/exec",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      const result = await execWorkspaceCommand(thread.workdir, req.body?.command ?? "");
      return reply.send(result);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/threads/:id/fs/tree",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      return reply.send({ entries: listWorkspaceDirectory(thread.workdir, req.query.path ?? "") });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/threads/:id/fs/read",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      if (!req.query.path?.trim()) return sendHttpError(reply, 400, "path is required");
      return reply.send(readWorkspaceFile(thread.workdir, req.query.path));
    },
  );

  app.put<{ Params: { id: string }; Body: { preview_url: string | null } }>(
    "/threads/:id/preview",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      const nextUrl = req.body?.preview_url?.trim() || null;
      const updated = updateThread(db, thread.id, { preview_url: nextUrl });
      if (!updated) return sendHttpError(reply, 404, "thread not found");
      const decorated = requireManager().decorateThread(updated);
      publishLiveEvent({
        type: "thread.updated",
        project_id: decorated.project_id,
        thread_id: decorated.id,
        payload: { action: "preview_updated", thread: decorated },
      });
      return reply.send({ thread: decorated });
    },
  );

  app.get<{ Params: { id: string } }>("/threads/:id/preview/detect", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    const detected = await detectLocalPreviewUrls();
    return reply.send({ detected, saved_url: thread.preview_url ?? null });
  });
}
