import { Command, Option } from "commander";
import { v4 as uuidv4 } from "uuid";

import { resolveConfig, type Scope, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from "../config.js";
import { openDb, type DB } from "../core/db.js";
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
} from "../core/messages.js";
import { getGraph } from "../core/graph.js";
import {
  createAgent,
  listAgents,
  deleteAgent,
  type ModelConfig,
} from "../core/agents.js";
import { logAudit, queryAudit } from "../core/audit.js";
import { logger } from "../log.js";

/**
 * Build the CLI command tree.
 *
 * Each leaf command runs against either:
 *   - a local SQLite file (default), OR
 *   - a remote HTTP server (when --http is passed)
 *
 * In remote mode we issue simple fetch() calls to the HTTP API.
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
    .action(async () => {
      const { runMcpServer } = await import("../mcp/server.js");
      const opts = program.opts();
      const scope = normaliseScope(opts.scope);
      await runMcpServer({ scope, overrideDataDir: opts.dataDir });
    });

  // serve -----------------------------------------------------------
  program
    .command("serve")
    .description("run the HTTP server")
    .option("--host <host>", "bind host", DEFAULT_HTTP_HOST)
    .option("--port <port>", "bind port", String(DEFAULT_HTTP_PORT))
    .action(async () => {
      const { startHttpServer } = await import("../http/server.js");
      const opts = program.opts();
      const serveOpts = program.commands.find((c) => c.name() === "serve")!.opts();
      const scope = normaliseScope(opts.scope);
      await startHttpServer({
        host: serveOpts.host,
        port: Number(serveOpts.port),
        scope,
        overrideDataDir: opts.dataDir,
      });
    });

  // path ------------------------------------------------------------
  program
    .command("path")
    .description("print the resolved data directory and db file")
    .action(() => {
      const opts = program.opts();
      const scope = normaliseScope(opts.scope);
      const cfg = resolveConfig(scope, opts.dataDir);
      console.log(JSON.stringify(cfg, null, 2));
    });

  // graph -----------------------------------------------------------
  program
    .command("graph")
    .description("show the session graph (nodes + edges)")
    .option("--status <status>", '"active" | "stale" | "ended" | "all"', "active")
    .action(async () => {
      const graphCmd = program.commands.find((c) => c.name() === "graph")!;
      const localOpts = graphCmd.opts();
      const res = await run(
        program,
        "GET",
        `/graph?status=${encodeURIComponent(localOpts.status ?? "active")}`
      );
      console.log(JSON.stringify(res, null, 2));
    });

  // sessions --------------------------------------------------------
  const sessions = program.command("sessions").description("manage sessions");

  sessions
    .command("list")
    .description("list registered sessions")
    .option("--status <status>", '"active" | "stale" | "ended" | "all"', "active")
    .action(async () => {
      const opts = sessions.opts();
      const localOpts = program.commands.find((c) => c.name() === "sessions")!.commands.find((c) => c.name() === "list")!.opts();
      const res = await run(program, "GET", `/sessions?status=${encodeURIComponent(localOpts.status ?? "active")}`);
      console.log(JSON.stringify(res, null, 2));
    });

  sessions
    .command("register")
    .description("register a session")
    .requiredOption("--name <name>")
    .option("--desc <description>")
    .action(async () => {
      const localOpts = sessions.commands.find((c) => c.name() === "register")!.opts();
      const res = await run(program, "POST", `/sessions/register`, {
        name: localOpts.name,
        description: localOpts.desc,
      });
      console.log(JSON.stringify(res, null, 2));
    });

  sessions
    .command("end")
    .description("mark a session as ended")
    .requiredOption("--id <id>")
    .action(async () => {
      const localOpts = sessions.commands.find((c) => c.name() === "end")!.opts();
      await runLocalOrRemote(
        program,
        () => {
          const db = openDbForCli(program);
          endSession(db, localOpts.id);
          logAudit(db, { caller_session: localOpts.id, interface: "cli", action: "end_session", args: { id: localOpts.id }, result: { ok: true } });
          return { ok: true };
        },
        async () => ({ ok: true }) // no dedicated endpoint; sessions naturally go stale
      ).then((r) => console.log(JSON.stringify(r, null, 2)));
    });

  // context ---------------------------------------------------------
  const context = program.command("context").description("manage published context");

  context
    .command("publish")
    .description("publish a context entry")
    .requiredOption("--title <title>")
    .requiredOption("--content <content>")
    .option("--tags <tags>", "comma-separated tags")
    .action(async () => {
      const localOpts = context.commands.find((c) => c.name() === "publish")!.opts();
      const tags = localOpts.tags ? String(localOpts.tags).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined;
      const res = await run(program, "POST", `/context`, {
        title: localOpts.title,
        content: localOpts.content,
        tags,
      });
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("list-mine")
    .description("list my session's published context")
    .action(async () => {
      const res = await run(program, "GET", `/context/mine`);
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("query")
    .argument("[query]", "FTS query")
    .option("--session <id>", "restrict to a session")
    .option("--tags <tags>", "comma-separated tags")
    .option("--limit <n>", "max results", "50")
    .action(async (query: string | undefined) => {
      const localOpts = context.commands.find((c) => c.name() === "query")!.opts();
      const qs = new URLSearchParams();
      if (query) qs.set("query", query);
      if (localOpts.session) qs.set("session_id", localOpts.session);
      if (localOpts.tags) qs.set("tags", localOpts.tags);
      if (localOpts.limit) qs.set("limit", String(localOpts.limit));
      const res = await run(program, "GET", `/context/query?${qs.toString()}`);
      console.log(JSON.stringify(res, null, 2));
    });

  context
    .command("delete")
    .description("delete one of your context entries")
    .requiredOption("--id <id>")
    .action(async () => {
      const localOpts = context.commands.find((c) => c.name() === "delete")!.opts();
      const res = await run(program, "DELETE", `/context/${localOpts.id}`);
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
    .action(async () => {
      const localOpts = agents.commands.find((c) => c.name() === "create")!.opts();
      const modelConfig: ModelConfig = {
        provider: localOpts.provider,
        model: localOpts.model,
      };
      if (localOpts.temperature !== undefined) modelConfig.temperature = localOpts.temperature;
      if (localOpts.maxTokens !== undefined) modelConfig.max_tokens = localOpts.maxTokens;
      const res = await run(program, "POST", `/agents`, {
        name: localOpts.name,
        system_prompt: localOpts.prompt,
        model_config: modelConfig,
        description: localOpts.desc,
      });
      console.log(JSON.stringify(res, null, 2));
    });

  agents
    .command("list")
    .description("list all agents")
    .action(async () => {
      const res = await run(program, "GET", `/agents`);
      console.log(JSON.stringify(res, null, 2));
    });

  agents
    .command("delete")
    .description("delete an agent")
    .requiredOption("--id <id>")
    .action(async () => {
      const localOpts = agents.commands.find((c) => c.name() === "delete")!.opts();
      const res = await run(program, "DELETE", `/agents/${localOpts.id}`);
      console.log(JSON.stringify(res, null, 2));
    });

  // msg -------------------------------------------------------------
  const msg = program.command("msg").description("inter-session messaging");

  msg
    .command("ask")
    .description("ask another session a question")
    .requiredOption("--to <session>")
    .argument("<question>")
    .action(async (question: string) => {
      const localOpts = msg.commands.find((c) => c.name() === "ask")!.opts();
      const res = await run(program, "POST", `/messages/ask`, {
        to_session: localOpts.to,
        question,
      });
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("inbox")
    .description("check questions addressed to your session")
    .action(async () => {
      const res = await run(program, "GET", `/messages/inbox`);
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("reply")
    .description("reply to a question")
    .requiredOption("--id <id>")
    .argument("<reply>")
    .action(async (reply: string) => {
      const localOpts = msg.commands.find((c) => c.name() === "reply")!.opts();
      const res = await run(program, "POST", `/messages/${localOpts.id}/reply`, { reply });
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("replies")
    .description("check replies to your questions")
    .option("--since <iso>", "only replies after this ISO timestamp")
    .action(async () => {
      const localOpts = msg.commands.find((c) => c.name() === "replies")!.opts();
      const qs = localOpts.since ? `?since=${encodeURIComponent(localOpts.since)}` : "";
      const res = await run(program, "GET", `/messages/replies${qs}`);
      console.log(JSON.stringify(res, null, 2));
    });

  msg
    .command("list")
    .description("list all messages globally (message-flow viewer)")
    .option("--from <session>", "filter by sender")
    .option("--to <session>", "filter by receiver")
    .option("--status <status>", '"pending" | "replied" | "read" | "all"')
    .option("--since <iso>", "only messages after this ISO timestamp")
    .option("--limit <n>", "max results", "50")
    .action(async () => {
      const localOpts = msg.commands.find((c) => c.name() === "list")!.opts();
      const qs = new URLSearchParams();
      if (localOpts.from) qs.set("from", localOpts.from);
      if (localOpts.to) qs.set("to", localOpts.to);
      if (localOpts.status) qs.set("status", localOpts.status);
      if (localOpts.since) qs.set("since", localOpts.since);
      if (localOpts.limit) qs.set("limit", String(localOpts.limit));
      const res = await run(program, "GET", `/messages?${qs.toString()}`);
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
    .action(async () => {
      const auditCmd = program.commands.find((c) => c.name() === "audit")!;
      const localOpts = auditCmd.opts();
      const qs = new URLSearchParams();
      if (localOpts.session) qs.set("session", localOpts.session);
      if (localOpts.action) qs.set("action", localOpts.action);
      if (localOpts.interface) qs.set("interface", localOpts.interface);
      if (localOpts.limit) qs.set("limit", String(localOpts.limit));
      const res = await run(program, "GET", `/audit?${qs.toString()}`);
      console.log(JSON.stringify(res, null, 2));
    });

  return program;
}

// --- helpers --------------------------------------------------------

function normaliseScope(s: string | undefined): Scope {
  if (s === "project") return "project";
  if (s === "global") return "global";
  return "global"; // "auto" + anything else falls back to global resolution
}

function openDbForCli(program: Command): DB {
  const opts = program.opts();
  const scope = normaliseScope(opts.scope);
  const cfg = resolveConfig(scope, opts.dataDir);
  return openDb(cfg);
}

/**
 * Run a command in either remote (HTTP) or local (SQLite) mode.
 * HTTP is used when --http is provided; otherwise local.
 *
 * The CLI session id resolves from MUILTCHAT_SESSION_ID env var (default:
 * a fresh UUID printed to stderr so the user can set it for subsequent calls).
 */
async function run(
  program: Command,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const opts = program.opts();
  if (opts.logLevel) (await import("../log.js")).setLogLevel(opts.logLevel);

  if (opts.http) {
    return remote(opts.http, method, path, body);
  }

  return runLocal(program, method, path, body);
}

async function runLocal(
  program: Command,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const db = openDbForCli(program);
  const sid = resolveCliSessionId(db);
  logger.debug({ sid, method, path }, "cli local");

  // Minimal router matching the HTTP surface.
  if (method === "GET" && path.startsWith("/sessions")) {
    const status = parseQs(path).get("status") ?? "active";
    return { sessions: listSessions(db, { status: status as never }) };
  }
  if (method === "POST" && path === "/sessions/register") {
    const b = body as { name: string; description?: string };
    const session = registerSession(db, {
      id: sid,
      name: b.name,
      description: b.description ?? null,
      project_dir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    });
    logAudit(db, { caller_session: sid, interface: "cli", action: "register_session", args: b as Record<string, unknown>, result: { session_id: sid } });
    return { session_id: sid, session };
  }
  if (method === "GET" && path === "/context/mine") {
    const entries = listMyContext(db, sid);
    logAudit(db, { caller_session: sid, interface: "cli", action: "list_my_context", args: {}, result: { count: entries.length } });
    return { entries };
  }
  if (method === "GET" && path.startsWith("/context/query")) {
    const qs = parseQs(path);
    const entries = queryContext(db, {
      query: qs.get("query") ?? undefined,
      session_id: qs.get("session_id") ?? undefined,
      tags: qs.get("tags") ? qs.get("tags")!.split(",") : undefined,
      limit: qs.get("limit") ? Number(qs.get("limit")) : undefined,
    });
    logAudit(db, { caller_session: sid, interface: "cli", action: "query_context", args: Object.fromEntries(qs), result: { count: entries.length } });
    return { entries };
  }
  if (method === "POST" && path === "/context") {
    const b = body as { title: string; content: string; tags?: string[] };
    const entry = publishContext(db, { session_id: sid, title: b.title, content: b.content, tags: b.tags ?? null });
    logAudit(db, { caller_session: sid, interface: "cli", action: "publish_context", args: { title: b.title, tags: b.tags }, result: { entry_id: entry.id } });
    return { entry };
  }
  if (method === "DELETE" && path.startsWith("/context/")) {
    const id = Number(path.split("/")[2]);
    const ok = deleteContext(db, id, sid);
    logAudit(db, { caller_session: sid, interface: "cli", action: "delete_context", args: { id }, result: { ok } });
    return { deleted: ok };
  }
  if (method === "POST" && path === "/messages/ask") {
    const b = body as { to_session: string; question: string };
    const m = askSession(db, { from_session: sid, to_session: b.to_session, question: b.question });
    logAudit(db, { caller_session: sid, interface: "cli", action: "ask_session", args: { to_session: b.to_session }, result: { message_id: m.id } });
    return { message: m };
  }
  if (method === "GET" && path === "/messages/inbox") {
    const inbox = checkInbox(db, sid);
    logAudit(db, { caller_session: sid, interface: "cli", action: "check_inbox", args: {}, result: { count: inbox.length } });
    return { inbox };
  }
  if (method === "POST" && path.includes("/reply")) {
    const id = Number(path.split("/")[2]);
    const b = body as { reply: string };
    const m = replyAsk(db, id, sid, b.reply);
    logAudit(db, { caller_session: sid, interface: "cli", action: "reply_ask", args: { id }, result: { message_id: m.id } });
    return { message: m };
  }
  if (method === "GET" && path.startsWith("/messages/replies")) {
    const qs = parseQs(path);
    const replies = checkReplies(db, sid, qs.get("since") ?? undefined);
    logAudit(db, { caller_session: sid, interface: "cli", action: "check_replies", args: { since: qs.get("since") }, result: { count: replies.length } });
    return { replies };
  }
  if (method === "GET" && path === "/agents") {
    const agentList = listAgents(db);
    logAudit(db, { caller_session: sid, interface: "cli", action: "list_agents", args: {}, result: { count: agentList.length } });
    return { agents: agentList };
  }
  if (method === "POST" && path === "/agents") {
    const b = body as { name: string; system_prompt: string; model_config: ModelConfig; description?: string };
    const agent = createAgent(db, {
      name: b.name,
      system_prompt: b.system_prompt,
      model_config: b.model_config,
      description: b.description ?? null,
    });
    logAudit(db, { caller_session: sid, interface: "cli", action: "create_agent", args: { name: b.name, provider: b.model_config.provider, model: b.model_config.model }, result: { id: agent.id } });
    return { agent };
  }
  if (method === "DELETE" && path.startsWith("/agents/")) {
    const id = Number(path.split("/")[2]);
    const ok = deleteAgent(db, id);
    logAudit(db, { caller_session: sid, interface: "cli", action: "delete_agent", args: { id }, result: { ok } });
    return { deleted: ok };
  }
  if (method === "GET" && path.startsWith("/graph")) {
    const qs = parseQs(path);
    const status = (qs.get("status") ?? "active") as "active" | "stale" | "ended" | "all";
    const graph = getGraph(db, { status });
    return graph;
  }
  if (method === "GET" && path.startsWith("/messages?")) {
    const qs = parseQs(path);
    const messages = listMessages(db, {
      from_session: qs.get("from") ?? undefined,
      to_session: qs.get("to") ?? undefined,
      status: (qs.get("status") as never) ?? undefined,
      since: qs.get("since") ?? undefined,
      limit: qs.get("limit") ? Number(qs.get("limit")) : undefined,
    });
    return { messages };
  }
  if (method === "GET" && path.startsWith("/audit")) {
    const qs = parseQs(path);
    return {
      entries: queryAudit(db, {
        session: qs.get("session") ?? undefined,
        action: qs.get("action") ?? undefined,
        iface: (qs.get("interface") as "mcp" | "http" | "cli" | undefined) ?? undefined,
        limit: qs.get("limit") ? Number(qs.get("limit")) : undefined,
      }),
    };
  }
  throw new Error(`unsupported local route: ${method} ${path}`);
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

async function runLocalOrRemote(
  program: Command,
  local: () => unknown,
  remoteFn: () => Promise<unknown>
): Promise<unknown> {
  const opts = program.opts();
  if (opts.http) return remoteFn();
  return local();
}

function parseQs(pathWithQs: string): URLSearchParams {
  const qIdx = pathWithQs.indexOf("?");
  return new URLSearchParams(qIdx >= 0 ? pathWithQs.slice(qIdx + 1) : "");
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
