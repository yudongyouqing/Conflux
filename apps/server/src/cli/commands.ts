import { Command, Option } from "commander";
import { v4 as uuidv4 } from "uuid";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

import { resolveConfig, type Scope, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from "../config.js";
import { openDb, type DB } from "../core/db.js";
import { handleHookEvent, readJsonFile } from "../core/live.js";
import { logger } from "../log.js";
import {
  registerSession,
  listSessions,
  endSession,
} from "../core/sessions.js";
import {
  publishContext,
  updateContext,
  deleteContext,
  listMyContext,
} from "../core/context.js";
import { queryContext } from "../core/search.js";
import {
  askSession,
  checkInbox,
  replyAsk,
  checkReplies,
  listMessages,
  formatInboxNotice,
} from "../core/messages.js";
import { getGraph } from "../core/graph.js";
import {
  createAgent,
  listAgents,
  deleteAgent,
  type ModelConfig,
} from "../core/agents.js";
import { logAudit, queryAudit } from "../core/audit.js";

/**
 * Build the CLI command tree.
 *
 * Each leaf command runs against either:
 *   - a local SQLite file (default): the action's local() closure calls the
 *     core function directly — no HTTP routing is involved
 *   - a remote HTTP server (when --http is passed): runOp falls back to fetch()
 *
 * Adding a new endpoint no longer requires touching two places: the core
 * function lives in the local() closure, and only --http mode needs the path.
 */
export function buildCli(): Command {
  const program = new Command();
  program
    .name("muiltchat")
    .description("Cross-session context query and conversation system")
    .version("0.1.0")
    .option(
      "--data-dir <path>",
      "override the muiltchat data directory (also via MUILTCHAT_HOME)"
    )
    .option("--scope <scope>", '"project" or "global" (default: auto)', "auto")
    .option(
      "--http <url>",
      "send commands to a remote HTTP server instead of the local SQLite file"
    )
    .option("--log-level <level>", "pino log level", "warn");

  // mcp -------------------------------------------------------------
  program
    .command("mcp")
    .description("run the stdio MCP server (Claude Code spawns this)")
    .action(async function (this: Command) {
      const { runMcpServer } = await import("../mcp/server.js");
      const o = this.optsWithGlobals();
      await runMcpServer({
        scope: normaliseScope(o.scope),
        overrideDataDir: o.dataDir,
      });
    });

  // serve -----------------------------------------------------------
  program
    .command("serve")
    .description("run the HTTP server")
    .option("--host <host>", "bind host", DEFAULT_HTTP_HOST)
    .option("--port <port>", "bind port", String(DEFAULT_HTTP_PORT))
    .action(async function (this: Command) {
      const { startHttpServer } = await import("../http/server.js");
      const o = this.optsWithGlobals();
      await startHttpServer({
        host: o.host,
        port: Number(o.port),
        scope: normaliseScope(o.scope),
        overrideDataDir: o.dataDir,
      });
    });

  // path ------------------------------------------------------------
  program
    .command("path")
    .description("print the resolved data directory and db file")
    .action(function (this: Command) {
      const o = this.optsWithGlobals();
      const cfg = resolveConfig(normaliseScope(o.scope), o.dataDir);
      console.log(JSON.stringify(cfg, null, 2));
    });

  // graph -----------------------------------------------------------
  program
    .command("graph")
    .description("show the session graph (nodes + edges)")
    .option("--status <status>", '"active" | "stale" | "ended" | "all"', "active")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const status = o.status ?? "active";
      const res = await runOp(
        program,
        () => getGraph(openDbFrom(o), { status }),
        "GET",
        `/graph?status=${encodeURIComponent(status)}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  // sessions --------------------------------------------------------
  const sessions = program.command("sessions").description("manage sessions");

  sessions
    .command("list")
    .description("list registered sessions")
    .option("--status <status>", '"active" | "stale" | "ended" | "all"', "active")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const status = o.status ?? "active";
      const res = await runOp(
        program,
        () => ({ sessions: listSessions(openDbFrom(o), { status }) }),
        "GET",
        `/sessions?status=${encodeURIComponent(status)}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  sessions
    .command("register")
    .description("register a session")
    .requiredOption("--name <name>")
    .option("--desc <description>")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const session = registerSession(db, {
            id: sid,
            name: o.name,
            description: o.desc ?? null,
            project_dir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
          });
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "register_session",
            args: { name: o.name, description: o.desc },
            result: { session_id: sid },
          });
          return { session_id: sid, session };
        },
        "POST",
        "/sessions/register",
        { name: o.name, description: o.desc }
      );
      console.log(JSON.stringify(res, null, 2));
    });

  sessions
    .command("end")
    .description("mark a session as ended")
    .requiredOption("--id <id>")
    .action(function (this: Command) {
      const o = this.optsWithGlobals();
      // No dedicated HTTP endpoint exists; remote sessions naturally go stale.
      const res = o.http
        ? { ok: true }
        : (() => {
            const db = openDbFrom(o);
            endSession(db, o.id);
            logAudit(db, {
              caller_session: o.id,
              interface: "cli",
              action: "end_session",
              args: { id: o.id },
              result: { ok: true },
            });
            return { ok: true };
          })();
      console.log(JSON.stringify(res, null, 2));
    });

  // context ---------------------------------------------------------
  const context = program.command("context").description("manage published context");

  context
    .command("publish")
    .description("publish a context entry")
    .requiredOption("--title <title>")
    .requiredOption("--content <content>")
    .option("--tags <tags>", "comma-separated tags")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const tags = parseTags(o.tags);
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const entry = publishContext(db, {
            session_id: sid,
            title: o.title,
            content: o.content,
            tags: tags ?? null,
          });
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "publish_context",
            args: { title: o.title, tags },
            result: { entry_id: entry.id },
          });
          return { entry };
        },
        "POST",
        "/context",
        { title: o.title, content: o.content, tags }
      );
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("list-mine")
    .description("list my session's published context")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const entries = listMyContext(db, sid);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "list_my_context",
            args: {},
            result: { count: entries.length },
          });
          return { entries };
        },
        "GET",
        "/context/mine"
      );
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("query")
    .description("full-text search across published context")
    .argument("[query]", "FTS query")
    .option("--session <id>", "restrict to a session")
    .option("--tags <tags>", "comma-separated tags")
    .option("--limit <n>", "max results", "50")
    .action(async function (this: Command, query: string | undefined) {
      const o = this.optsWithGlobals();
      const tags = parseTags(o.tags);
      const args = {
        query,
        session_id: o.session,
        tags,
        limit: o.limit ? Number(o.limit) : undefined,
      };
      const qs = new URLSearchParams();
      if (query) qs.set("query", query);
      if (o.session) qs.set("session_id", o.session);
      if (o.tags) qs.set("tags", o.tags);
      if (o.limit) qs.set("limit", String(o.limit));
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const entries = queryContext(db, args);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "query_context",
            args,
            result: { count: entries.length },
          });
          return { entries };
        },
        "GET",
        `/context/query?${qs.toString()}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("update")
    .description("update one of your context entries")
    .requiredOption("--id <id>")
    .option("--title <title>")
    .option("--content <content>")
    .option("--tags <tags>", "comma-separated tags")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const id = Number(o.id);
      const tags = parseTags(o.tags);
      const patch: { title?: string; content?: string; tags?: string[] } = {};
      if (o.title !== undefined) patch.title = o.title;
      if (o.content !== undefined) patch.content = o.content;
      if (tags !== undefined) patch.tags = tags;
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const entry = updateContext(db, id, sid, patch);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "update_context",
            args: { id, ...patch },
            result: entry ? { id: entry.id } : null,
          });
          return { entry: entry ?? null };
        },
        "PUT",
        `/context/${id}`,
        patch
      );
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("delete")
    .description("delete one of your context entries")
    .requiredOption("--id <id>")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const id = Number(o.id);
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const ok = deleteContext(db, id, sid);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "delete_context",
            args: { id },
            result: { ok },
          });
          return { deleted: ok };
        },
        "DELETE",
        `/context/${id}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  // agents ----------------------------------------------------------
  const agents = program.command("agents").description("manage internal agent definitions");

  agents
    .command("create")
    .description("create a new internal agent")
    .requiredOption("--name <name>")
    .requiredOption("--prompt <system_prompt>")
    .requiredOption("--provider <provider>", '"anthropic" | "openai" | ...')
    .requiredOption("--model <model>")
    .option("--desc <description>")
    .option("--temperature <n>", "sampling temperature", parseFloat)
    .option("--max-tokens <n>", "max output tokens", parseInt)
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const modelConfig: ModelConfig = {
        provider: o.provider,
        model: o.model,
      };
      if (o.temperature !== undefined) modelConfig.temperature = o.temperature;
      if (o.maxTokens !== undefined) modelConfig.max_tokens = o.maxTokens;
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const agent = createAgent(db, {
            name: o.name,
            system_prompt: o.prompt,
            model_config: modelConfig,
            description: o.desc ?? null,
          });
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "create_agent",
            args: { name: o.name, provider: o.provider, model: o.model },
            result: { id: agent.id },
          });
          return { agent };
        },
        "POST",
        "/agents",
        {
          name: o.name,
          system_prompt: o.prompt,
          model_config: modelConfig,
          description: o.desc,
        }
      );
      console.log(JSON.stringify(res, null, 2));
    });

  agents
    .command("list")
    .description("list all agents")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const agentList = listAgents(db);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "list_agents",
            args: {},
            result: { count: agentList.length },
          });
          return { agents: agentList };
        },
        "GET",
        "/agents"
      );
      console.log(JSON.stringify(res, null, 2));
    });

  agents
    .command("delete")
    .description("delete an agent")
    .requiredOption("--id <id>")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const id = Number(o.id);
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const ok = deleteAgent(db, id);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "delete_agent",
            args: { id },
            result: { ok },
          });
          return { deleted: ok };
        },
        "DELETE",
        `/agents/${id}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  // msg -------------------------------------------------------------
  const msg = program.command("msg").description("inter-session messaging");

  msg
    .command("ask")
    .description("ask another session a question")
    .requiredOption("--to <session>")
    .argument("<question>")
    .action(async function (this: Command, question: string) {
      const o = this.optsWithGlobals();
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const m = askSession(db, {
            from_session: sid,
            to_session: o.to,
            question,
          });
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "ask_session",
            args: { to_session: o.to },
            result: { message_id: m.id },
          });
          return { message: m };
        },
        "POST",
        "/messages/ask",
        { to_session: o.to, question }
      );
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("inbox")
    .description("check questions addressed to your session")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const inbox = checkInbox(db, sid);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "check_inbox",
            args: {},
            result: { count: inbox.length },
          });
          return { inbox };
        },
        "GET",
        "/messages/inbox"
      );
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("reply")
    .description("reply to a question")
    .requiredOption("--id <id>")
    .argument("<reply>")
    .action(async function (this: Command, reply: string) {
      const o = this.optsWithGlobals();
      const id = Number(o.id);
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const m = replyAsk(db, id, sid, reply);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "reply_ask",
            args: { id },
            result: { message_id: m.id },
          });
          return { message: m };
        },
        "POST",
        `/messages/${id}/reply`,
        { reply }
      );
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("replies")
    .description("check replies to your questions")
    .option("--since <iso>", "only replies after this ISO timestamp")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const qs = o.since ? `?since=${encodeURIComponent(o.since)}` : "";
      const res = await runOp(
        program,
        () => {
          const db = openDbFrom(o);
          const sid = resolveCliSessionId(db);
          const replies = checkReplies(db, sid, o.since);
          logAudit(db, {
            caller_session: sid,
            interface: "cli",
            action: "check_replies",
            args: { since: o.since },
            result: { count: replies.length },
          });
          return { replies };
        },
        "GET",
        `/messages/replies${qs}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("list")
    .description("list all messages globally (message-flow viewer)")
    .option("--from <session>", "filter by sender")
    .option("--to <session>", "filter by receiver")
    .option("--status <status>", '"pending" | "seen" | "replied" | "read" | "all"')
    .option("--since <iso>", "only messages after this ISO timestamp")
    .option("--limit <n>", "max results", "50")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const args = {
        from_session: o.from,
        to_session: o.to,
        status: o.status,
        since: o.since,
        limit: o.limit ? Number(o.limit) : undefined,
      };
      const qs = new URLSearchParams();
      if (o.from) qs.set("from", o.from);
      if (o.to) qs.set("to", o.to);
      if (o.status) qs.set("status", o.status);
      if (o.since) qs.set("since", o.since);
      if (o.limit) qs.set("limit", String(o.limit));
      const res = await runOp(
        program,
        () => ({ messages: listMessages(openDbFrom(o), args) }),
        "GET",
        `/messages?${qs.toString()}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  // audit -----------------------------------------------------------
  program
    .command("audit")
    .description("query audit log")
    .option("--session <id>")
    .option("--action <name>")
    .addOption(
      new Option("--interface <iface>").choices(["mcp", "http", "cli"])
    )
    .option("--limit <n>", "max results", "50")
    .action(async function (this: Command) {
      const o = this.optsWithGlobals();
      const qs = new URLSearchParams();
      if (o.session) qs.set("session", o.session);
      if (o.action) qs.set("action", o.action);
      if (o.interface) qs.set("interface", o.interface);
      if (o.limit) qs.set("limit", String(o.limit));
      const res = await runOp(
        program,
        () => ({
          entries: queryAudit(openDbFrom(o), {
            session: o.session,
            action: o.action,
            iface: o.interface,
            limit: o.limit ? Number(o.limit) : undefined,
          }),
        }),
        "GET",
        `/audit?${qs.toString()}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  // hooks ------------------------------------------------------------
  const hooks = program.command("hooks").description("Claude Code hook integration (liveness + naming)");

  hooks
    .command("install")
    .description("install muiltchat hooks into ~/.claude/settings.json (backs up first)")
    .action(function (this: Command) {
      const settingsPath = claudeSettingsPath();
      const settings = readJsonFile(settingsPath);
      const hooksCfg = (settings.hooks ?? {}) as Record<string, unknown>;

      try {
        if (existsSync(settingsPath)) {
          copyFileSync(settingsPath, `${settingsPath}.muiltchat-bak`);
        }
      } catch {
        // non-fatal
      }

      const base = hookCommandBase();
      for (const event of HOOK_EVENTS) {
        const key = HOOK_SETTINGS_KEYS[event];
        const entries = Array.isArray(hooksCfg[key])
          ? (hooksCfg[key] as Record<string, unknown>[])
          : [];
        const cleaned = entries
          .map((e) => {
            if (Array.isArray(e.hooks)) {
              e.hooks = (e.hooks as Record<string, unknown>[]).filter(
                (h) => !(typeof h.command === "string" && h.command.includes("muiltchat hooks dispatch"))
              );
            }
            return e;
          })
          .filter((e) => !Array.isArray(e.hooks) || e.hooks.length > 0);
        cleaned.push({
          hooks: [{ type: "command", command: `${base} hooks dispatch ${event}` }],
        });
        hooksCfg[key] = cleaned;
      }
      settings.hooks = hooksCfg;
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

      console.log(
        `installed hooks for [${HOOK_EVENTS.join(", ")}] -> ${settingsPath}\n` +
          `entry: ${base}\n` +
          `new Claude Code sessions will now register themselves (id = conversation id, name = first prompt).`
      );
    });

  hooks
    .command("uninstall")
    .description("remove muiltchat hooks from ~/.claude/settings.json")
    .action(function (this: Command) {
      const settingsPath = claudeSettingsPath();
      const settings = readJsonFile(settingsPath);
      const hooksCfg = (settings.hooks ?? {}) as Record<string, unknown>;
      let removed = 0;
      for (const event of HOOK_EVENTS) {
        const key = HOOK_SETTINGS_KEYS[event];
        if (!Array.isArray(hooksCfg[key])) continue;
        const entries = (hooksCfg[key] as Record<string, unknown>[]).map((e) => {
          if (Array.isArray(e.hooks)) {
            e.hooks = (e.hooks as Record<string, unknown>[]).filter((h) => {
              const ours =
                typeof h.command === "string" && h.command.includes("muiltchat hooks dispatch");
              if (ours) removed++;
              return !ours;
            });
          }
          return e;
        });
        const kept = entries.filter((e) => !Array.isArray(e.hooks) || e.hooks.length > 0);
        if (kept.length > 0) hooksCfg[key] = kept;
        else delete hooksCfg[key];
      }
      if (Object.keys(hooksCfg).length > 0) settings.hooks = hooksCfg;
      else delete settings.hooks;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      console.log(`removed ${removed} hook entr${removed === 1 ? "y" : "ies"} from ${settingsPath}`);
    });

  hooks
    .command("dispatch <event>")
    .description("(internal) handle a Claude Code hook event from stdin JSON")
    .action(async function (this: Command, event: string) {
      if (!HOOK_EVENTS.includes(event as HookEvent)) {
        process.stderr.write(`unknown hook event: ${event}\n`);
        process.exitCode = 1;
        return;
      }
      let payload: Record<string, unknown> = {};
      try {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.trim()) payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // malformed stdin — ignore quietly, hooks must never block a session
      }
      try {
        const db = openDb(resolveConfig("global"));
        handleHookEvent(db, event as HookEvent, payload as never);
        // UserPromptSubmit / SessionStart stdout is injected into the
        // conversation context — the only push channel into a live session.
        // Silent unless there is unread mail, so hooks never spam.
        if (event === "prompt" || event === "session-start") {
          const sid = typeof payload.session_id === "string" ? payload.session_id : null;
          if (sid) {
            const notice = formatInboxNotice(db, sid);
            if (notice) process.stdout.write(notice + "\n");
          }
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "hook dispatch failed");
      }
    });

  return program;
}

// --- helpers --------------------------------------------------------

type HookEvent = "session-start" | "prompt" | "stop";
const HOOK_EVENTS: HookEvent[] = ["session-start", "prompt", "stop"];

/** Our dispatch arg -> the canonical Claude Code settings.json event key. */
const HOOK_SETTINGS_KEYS: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  stop: "Stop",
};

function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(dir, "settings.json");
}

/**
 * Absolute command prefix the hooks will invoke. Prefers the built dist
 * output (works from any cwd, no tsx needed); falls back to whatever
 * entrypoint is currently running.
 */
function hookCommandBase(): string {
  const argv1 = resolve(process.argv[1]);
  const asDist = argv1.replace(/src([\\/])index\.ts$/, "dist$1index.js");
  const entry = asDist.endsWith(".js") && existsSync(asDist) ? asDist : argv1;
  return entry.endsWith(".js") ? `node "${entry}"` : `npx tsx "${entry}"`;
}

function normaliseScope(s: string | undefined): Scope {
  if (s === "project") return "project";
  if (s === "global") return "global";
  return "global"; // "auto" + anything else falls back to global resolution
}

/** Options available on every command via optsWithGlobals(). */
interface CliOpts {
  dataDir?: string;
  scope?: string;
  http?: string;
  logLevel?: string;
}

function openDbFrom(o: CliOpts): DB {
  const cfg = resolveConfig(normaliseScope(o.scope), o.dataDir);
  return openDb(cfg);
}

/**
 * Execute one CLI operation in local or remote mode.
 *
 * - `--http` passed: fetch() against the remote HTTP server (path is only
 *   used in this branch).
 * - otherwise: invoke the `local()` closure, which calls the core function
 *   directly and logs its own audit entry. No route mirroring involved.
 */
async function runOp(
  program: Command,
  local: () => unknown,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const opts = program.opts();
  if (opts.logLevel) {
    const { setLogLevel } = await import("../log.js");
    setLogLevel(opts.logLevel);
  }
  if (opts.http) {
    return remote(opts.http, method, path, body);
  }
  return local();
}

async function remote(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const sid = process.env.MUILTCHAT_SESSION_ID || uuidv4();
  const headers: Record<string, string> = {
    "X-Session-Id": sid,
    "Content-Type": "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function parseTags(raw: string | undefined): string[] | undefined {
  return raw
    ? String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

/**
 * Resolve the CLI session id.
 *
 * - If `MUILTCHAT_SESSION_ID` env var is set, use it.
 * - Otherwise generate a new UUID, auto-register it as a transient session
 *   named "cli", and print a hint to stderr (so stdout stays machine-readable).
 */
function resolveCliSessionId(db: DB): string {
  const env = process.env.MUILTCHAT_SESSION_ID;
  if (env && env.trim().length > 0) return env;

  const sid = uuidv4();
  registerSession(db, {
    id: sid,
    name: `cli-${process.env.USER || process.env.USERNAME || "anon"}`,
    description: "ad-hoc CLI invocation",
    project_dir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  });
  process.env.MUILTCHAT_SESSION_ID = sid;
  process.stderr.write(
    `muiltchat: registered transient CLI session ${sid}\n` +
      `set MUILTCHAT_SESSION_ID=${sid} to reuse it across commands\n`
  );
  return sid;
}
