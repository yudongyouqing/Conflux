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
import {
  applyNativeCliProvider,
  deleteProviderPreset,
  getStoredProviderPreset,
  listProviderPresets,
  probeCliBinaries,
  readNativeCliProviders,
  saveProviderPreset,
} from "../../core/cli-providers.js";
import { logAudit } from "../../core/audit.js";
import type { RuntimeId, TerminalSettings } from "@conflux/shared";
import type { ServerContext } from "../context.js";

export function registerSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db, sendError, write } = ctx;

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
      const terminal = getTerminalSettings(db);
      return reply.send({
        terminal,
        options: terminalOptions(),
        binaries: probeCliBinaries(terminal),
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
            terminal: { type: "string", enum: ["wt", "powershell", "cmd", "wezterm", "terminal", "iterm", "tmux"] },
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
        const terminal = await write(() => {
          const saved = saveTerminalSettings(db, req.body);
          if (typeof req.body.auto_wake === "boolean") setAutoWake(db, req.body.auto_wake);
          if (typeof req.body.wake_max_concurrent === "number") {
            setWakeMaxConcurrent(db, req.body.wake_max_concurrent);
          }
          logAudit(db, {
            interface: "http",
            action: "save_terminal_settings",
            args: { terminal: saved.terminal },
          });
          return saved;
        });
        return reply.send({
          terminal,
          binaries: probeCliBinaries(terminal),
          auto_wake: getAutoWake(db),
          wake_max_concurrent: getWakeMaxConcurrent(db),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- CLI provider presets & native config (~/.claude/settings.json, ~/.codex/config.toml) ----
  app.get("/settings/cli-providers", {}, async (_req, reply) => {
    try {
      return reply.send({
        native: readNativeCliProviders(),
        presets: listProviderPresets(db),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{
    Body: {
      id?: string;
      name: string;
      runtime: RuntimeId;
      base_url?: string | null;
      model?: string | null;
      api_key?: string | null;
      extra_env?: string | null;
    };
  }>(
    "/settings/cli-providers/presets",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "runtime"],
          properties: {
            id: { type: "string", maxLength: 64 },
            name: { type: "string", minLength: 1, maxLength: 100 },
            runtime: { type: "string", enum: ["claude", "codex"] },
            base_url: { type: ["string", "null"], maxLength: 500 },
            model: { type: ["string", "null"], maxLength: 200 },
            api_key: { type: ["string", "null"], maxLength: 500 },
            extra_env: { type: ["string", "null"], maxLength: 4000 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const preset = await write(() => {
          const saved = saveProviderPreset(db, req.body);
          logAudit(db, {
            interface: "http",
            action: "save_cli_provider_preset",
            args: { id: saved.id, runtime: saved.runtime },
          });
          return saved;
        });
        return reply.code(201).send({ preset, presets: listProviderPresets(db) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/settings/cli-providers/presets/:id",
    {},
    async (req, reply) => {
      try {
        const deleted = await write(() => deleteProviderPreset(db, req.params.id));
        if (!deleted) {
          return reply.code(404).send({ error: "preset not found" });
        }
        return reply.send({ ok: true, presets: listProviderPresets(db) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{
    Body: {
      preset_id?: string;
      runtime?: RuntimeId;
      base_url?: string | null;
      model?: string | null;
      api_key?: string | null;
      extra_env?: string | null;
    };
  }>(
    "/settings/cli-providers/apply",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            preset_id: { type: "string", maxLength: 64 },
            runtime: { type: "string", enum: ["claude", "codex"] },
            base_url: { type: ["string", "null"], maxLength: 500 },
            model: { type: ["string", "null"], maxLength: 200 },
            api_key: { type: ["string", "null"], maxLength: 500 },
            extra_env: { type: ["string", "null"], maxLength: 4000 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body;
        let target: {
          runtime: RuntimeId;
          base_url?: string | null;
          model?: string | null;
          api_key?: string | null;
          extra_env?: string | null;
        };
        if (body.preset_id) {
          const preset = getStoredProviderPreset(db, body.preset_id);
          if (!preset) return reply.code(404).send({ error: "preset not found" });
          target = preset;
        } else if (body.runtime === "claude" || body.runtime === "codex") {
          target = {
            runtime: body.runtime,
            base_url: body.base_url,
            model: body.model,
            api_key: body.api_key,
            extra_env: body.extra_env,
          };
        } else {
          return reply.code(400).send({ error: "preset_id or runtime is required" });
        }

        const result = applyNativeCliProvider(target);
        logAudit(db, {
          interface: "http",
          action: "apply_native_cli_provider",
          args: { runtime: target.runtime, preset_id: body.preset_id ?? null },
        });
        return reply.send({ ok: true, ...result });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
