import type { FastifyInstance } from "fastify";
import { providerRegistry } from "../../core/providers.js";
import {
  getAutoWake,
  getTerminalSettings,
  saveTerminalSettings,
  setAutoWake,
  getWakeMaxConcurrent,
  setWakeMaxConcurrent,
} from "../../core/app-settings.js";
import { getActiveWakeCount } from "../../core/wake/index.js";
import { terminalOptions } from "../../core/terminal.js";
import { logAudit } from "../../core/audit.js";
import type { TerminalSettings } from "@conflux/shared";
import type { ServerContext } from "../context.js";

export function registerSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError } = ctx;

  // GET /settings — check API key status (derived from the provider registry)
  app.get("/settings", {}, async (_req, reply) => {
    const providers: Record<string, { configured: boolean }> = {};
    for (const [name, entry] of Object.entries(providerRegistry)) {
      providers[name] = { configured: entry.hasKey() };
    }
    return reply.send({ providers });
  });

  // ---- terminal settings (opener used by "open in terminal" + agent start) ----
  app.get("/settings/terminal", {}, async (_req, reply) => {
    try {
      return reply.send({
        terminal: getTerminalSettings(db),
        options: terminalOptions(),
        auto_wake: getAutoWake(db),
        wake_max_concurrent: getWakeMaxConcurrent(db),
        wake_active_count: getActiveWakeCount(),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Body: Partial<TerminalSettings> & { auto_wake?: boolean; wake_max_concurrent?: number } }>(
    "/settings/terminal",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            terminal: { type: "string", enum: ["wt", "powershell", "cmd", "wezterm"] },
            claude_path: { type: "string", maxLength: 500 },
            codex_path: { type: "string", maxLength: 500 },
            auto_wake: { type: "boolean" },
            wake_max_concurrent: { type: "number", minimum: 0, maximum: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const terminal = saveTerminalSettings(db, req.body);
        if (typeof req.body.auto_wake === "boolean") setAutoWake(db, req.body.auto_wake);
        if (typeof req.body.wake_max_concurrent === "number") {
          setWakeMaxConcurrent(db, req.body.wake_max_concurrent);
        }
        logAudit(db, {
          interface: "http",
          action: "save_terminal_settings",
          args: { terminal: terminal.terminal },
        });
        return reply.send({
          terminal,
          auto_wake: getAutoWake(db),
          wake_max_concurrent: getWakeMaxConcurrent(db),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
