import type { FastifyInstance } from "fastify";
import type { AgentThread, MicaBadgeState, MicaPaneInfo } from "@conflux/shared";
import { publishLiveEvent } from "../../core/event-bus.js";
import { resolveMicaExecutable } from "../../core/runtime-env.js";
import { getThread, updateThread } from "../../core/threads/store.js";
import { getThreadManager } from "../../core/threads/executor.js";
import {
  createDefaultMicaRunner,
  createMicaClient,
  MicaCliError,
  type MicaClient,
} from "../../core/mica/client.js";
import { getMicaBridge, unbindMicaPane } from "../../core/mica/watcher.js";
import type { ServerContext } from "../context.js";

const VALID_BADGE_STATES = new Set<MicaBadgeState>(["none", "idle", "running", "attention"]);

function micaHttpError(err: MicaCliError): { statusCode: number; message: string } {
  switch (err.code) {
    case "spawn_failed":
      return { statusCode: 503, message: err.message };
    case "timeout":
      return { statusCode: 504, message: err.message };
    default:
      return { statusCode: 500, message: err.message };
  }
}

function isMicaCliError(err: unknown): err is MicaCliError {
  return err instanceof MicaCliError;
}

export function registerMicaTerminalRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendHttpError, write } = ctx;

  // The bridge owns the runner (and thus test shims); fall back to a direct
  // default-runner client only when the bridge was never mounted.
  const client = (): MicaClient =>
    getMicaBridge()?.client() ?? createMicaClient(createDefaultMicaRunner(resolveMicaExecutable(db)));

  const decorate = (thread: AgentThread): AgentThread => {
    const manager = getThreadManager();
    return manager ? manager.decorateThread(thread) : thread;
  };

  const publishThreadUpdated = (thread: AgentThread, action: string, extra: Record<string, unknown> = {}) => {
    publishLiveEvent({
      type: "thread.updated",
      project_id: thread.project_id,
      thread_id: thread.id,
      payload: { action, thread, ...extra },
    });
  };

  // A pane disappeared underneath us: drop the binding, tell the client why.
  const handleBadTarget = (reply: Parameters<ServerContext["sendHttpError"]>[0], thread: AgentThread): void => {
    unbindMicaPane(db, thread.mica_pane_id!, "bad_target");
    getMicaBridge()?.notifyBindingChanged();
    sendHttpError(reply, 404, "绑定的 Mica pane 已关闭，已自动解除绑定，请重新打开或绑定其他 Pane");
  };

  app.get("/mica/status", async (_req, reply) => {
    const executable = resolveMicaExecutable(db);
    try {
      const { running, panes } = await client().list();
      return reply.send({ available: true, running, executable, panes });
    } catch (err) {
      if (isMicaCliError(err) && err.code === "spawn_failed") {
        return reply.send({ available: false, running: false, executable, panes: [] });
      }
      throw isMicaCliError(err) ? Object.assign(new Error(err.message), micaHttpError(err)) : err;
    }
  });

  app.get("/mica/panes", async (_req, reply) => {
    try {
      const { running, panes } = await client().list();
      return reply.send({ running, panes });
    } catch (err) {
      if (isMicaCliError(err) && err.code === "spawn_failed") {
        return reply.send({ running: false, panes: [] });
      }
      throw isMicaCliError(err) ? Object.assign(new Error(err.message), micaHttpError(err)) : err;
    }
  });

  app.post<{
    Params: { id: string };
    Body: { mode?: "tab" | "window"; command?: string; force_new?: boolean };
  }>("/threads/:id/mica/open", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    const mode = req.body?.mode === "window" ? "window" : "tab";
    const forceNew = Boolean(req.body?.force_new);

    try {
      if (!forceNew && thread.mica_pane_id != null) {
        const { running, panes } = await client().list();
        const existing = panes.find((p) => p.pane_id === thread.mica_pane_id);
        if (running && existing) {
          await client().focus(existing.pane_id);
          return reply.send({ pane: existing, thread: decorate(thread), reused: true });
        }
        // Stale binding: fall through and replace it with a fresh pane.
      }

      const pane = await client().openPane({
        mode,
        cwd: thread.workdir,
        ...(req.body?.command?.trim() ? { command: req.body.command.trim() } : {}),
        env: {
          CONFLUX_SESSION_ID: thread.id,
          CONFLUX_THREAD_NAME: thread.name,
        },
      });
      const updated = await write(() => updateThread(db, thread.id, { mica_pane_id: pane.pane_id }));
      if (!updated) return sendHttpError(reply, 404, "thread not found");
      const decorated = decorate(updated);
      publishThreadUpdated(decorated, "mica_bound", { pane_id: pane.pane_id });
      getMicaBridge()?.notifyBindingChanged();
      return reply.send({ pane, thread: decorated, reused: false });
    } catch (err) {
      if (isMicaCliError(err)) throw Object.assign(new Error(err.message), micaHttpError(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: { pane_id?: number } }>(
    "/threads/:id/mica/attach",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      const paneId = Number(req.body?.pane_id);
      if (!Number.isSafeInteger(paneId) || paneId <= 0) {
        return sendHttpError(reply, 400, "pane_id must be a positive integer");
      }
      try {
        const { running, panes } = await client().list();
        const pane: MicaPaneInfo | undefined = panes.find((p) => p.pane_id === paneId);
        if (!running || !pane) {
          return sendHttpError(reply, 404, `Mica pane #${paneId} 不存在或已关闭`);
        }
        const updated = await write(() => updateThread(db, thread.id, { mica_pane_id: paneId }));
        if (!updated) return sendHttpError(reply, 404, "thread not found");
        const decorated = decorate(updated);
        publishThreadUpdated(decorated, "mica_bound", { pane_id: paneId });
        getMicaBridge()?.notifyBindingChanged();
        return reply.send({ pane, thread: decorated });
      } catch (err) {
        if (isMicaCliError(err)) throw Object.assign(new Error(err.message), micaHttpError(err));
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/threads/:id/mica", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    const updated = await write(() => updateThread(db, thread.id, { mica_pane_id: null }));
    if (!updated) return sendHttpError(reply, 404, "thread not found");
    const decorated = decorate(updated);
    publishThreadUpdated(decorated, "mica_unbound", { reason: "user" });
    getMicaBridge()?.notifyBindingChanged();
    return reply.send({ thread: decorated });
  });

  app.post<{ Params: { id: string } }>("/threads/:id/mica/focus", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    if (thread.mica_pane_id == null) {
      return sendHttpError(reply, 400, "该线程未绑定 Mica pane，请先「在 Mica 中打开」或绑定已有 Pane");
    }
    try {
      await client().focus(thread.mica_pane_id);
      return reply.send({ ok: true });
    } catch (err) {
      if (isMicaCliError(err) && err.code === "bad_target") return handleBadTarget(reply, thread);
      if (isMicaCliError(err)) throw Object.assign(new Error(err.message), micaHttpError(err));
      throw err;
    }
  });

  app.post<{
    Params: { id: string };
    Body: { text?: string; submit?: boolean; literal?: boolean };
  }>("/threads/:id/mica/send", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    if (thread.mica_pane_id == null) {
      return sendHttpError(reply, 400, "该线程未绑定 Mica pane，请先「在 Mica 中打开」或绑定已有 Pane");
    }
    const text = req.body?.text;
    if (typeof text !== "string" || text.length === 0) {
      return sendHttpError(reply, 400, "text is required");
    }
    const submit = Boolean(req.body?.submit);
    const literal = Boolean(req.body?.literal);
    try {
      if (literal) {
        // Raw text first, then a separate Enter via the default escape mode.
        await client().send(thread.mica_pane_id, text, { literal: true });
        if (submit) await client().send(thread.mica_pane_id, "\\r");
      } else {
        // Default mode interprets the two-char \r escape as Enter.
        await client().send(thread.mica_pane_id, submit ? `${text}\\r` : text);
      }
      return reply.send({ ok: true });
    } catch (err) {
      if (isMicaCliError(err) && err.code === "bad_target") return handleBadTarget(reply, thread);
      if (isMicaCliError(err)) throw Object.assign(new Error(err.message), micaHttpError(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { scrollback?: string; lines?: string } }>(
    "/threads/:id/mica/read",
    async (req, reply) => {
      const thread = getThread(db, req.params.id);
      if (!thread) return sendHttpError(reply, 404, "thread not found");
      if (thread.mica_pane_id == null) {
        return sendHttpError(reply, 400, "该线程未绑定 Mica pane，请先「在 Mica 中打开」或绑定已有 Pane");
      }
      const scrollback = req.query.scrollback === "1" || req.query.scrollback === "true";
      const lines = req.query.lines ? Number(req.query.lines) : undefined;
      try {
        const result = await client().read(thread.mica_pane_id, {
          scrollback,
          ...(Number.isFinite(lines) && lines ? { lines } : {}),
        });
        return reply.send(result);
      } catch (err) {
        if (isMicaCliError(err) && err.code === "bad_target") return handleBadTarget(reply, thread);
        if (isMicaCliError(err)) throw Object.assign(new Error(err.message), micaHttpError(err));
        throw err;
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { state?: MicaBadgeState; text?: string; sticky?: boolean };
  }>("/threads/:id/mica/badge", async (req, reply) => {
    const thread = getThread(db, req.params.id);
    if (!thread) return sendHttpError(reply, 404, "thread not found");
    if (thread.mica_pane_id == null) {
      return sendHttpError(reply, 400, "该线程未绑定 Mica pane，请先「在 Mica 中打开」或绑定已有 Pane");
    }
    const state = req.body?.state;
    if (!state || !VALID_BADGE_STATES.has(state)) {
      return sendHttpError(reply, 400, "state must be one of none | idle | running | attention");
    }
    try {
      await client().setBadge(thread.mica_pane_id, {
        state,
        ...(req.body?.text ? { text: req.body.text.slice(0, 32) } : {}),
        sticky: Boolean(req.body?.sticky),
      });
      return reply.send({ ok: true });
    } catch (err) {
      if (isMicaCliError(err) && err.code === "bad_target") return handleBadTarget(reply, thread);
      if (isMicaCliError(err)) throw Object.assign(new Error(err.message), micaHttpError(err));
      throw err;
    }
  });
}
