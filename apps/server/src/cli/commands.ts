import { Command } from "commander";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { APP_VERSION } from "../version.js";
import { resolveConfig, resolveHttpHost, resolveHttpPort, type Scope } from "../config.js";
import { openDb, stopWalCheckpoint } from "../core/db.js";
import { startHttpServer } from "../http/server.js";
import { startMcpServer } from "../mcp/server.js";
import { createProject, listProjects } from "../core/projects.js";
import { isValidRuntime, listThreads } from "../core/threads/store.js";
import { probeLocalClis } from "../core/cli-probe.js";
import { approveHumanGate, getWorkflowRun, listWorkflows, startWorkflowRun } from "../core/workflows.js";
import { handoffContext } from "../core/handoff.js";
import {
  detectLocalNetworkInfo,
  executeOriginalDirectoryWake,
  installCliHook,
  type HookTargetCli,
} from "../core/hooks.js";
import { WEB_CONSOLE_ID } from "@conflux/shared";

interface GlobalOpts {
  dataDir?: string;
  scope?: Scope;
}

function withDb<T>(opts: GlobalOpts, fn: (db: ReturnType<typeof openDb>) => Promise<T> | T): Promise<T> {
  const config = resolveConfig(opts.scope ?? "global", opts.dataDir);
  const db = openDb(config);
  return Promise.resolve(fn(db)).finally(() => {
    stopWalCheckpoint(db);
    if (db.open) db.close();
  });
}

export function buildCli(_argv?: string[]): Command {
  const program = new Command();
  program
    .name("conflux")
    .description("Conflux v2 — Project-first multi-agent workbench & orchestration control plane")
    .version(APP_VERSION)
    .option("--data-dir <path>", "Override Conflux data directory (holds conflux-v2.db)")
    .option("--scope <scope>", "Config scope: global | project", "global");

  program
    .command("serve")
    .description("Start the Conflux v2 HTTP + SSE server and Web UI")
    .option("-H, --host <host>", "Bind host")
    .option("-p, --port <port>", "Bind port")
    .action(async (cmdOpts: { host?: string; port?: string }) => {
      const g = program.opts<GlobalOpts>();
      const port = cmdOpts.port ? Number(cmdOpts.port) : undefined;
      const app = await startHttpServer({
        host: resolveHttpHost(cmdOpts.host),
        port: resolveHttpPort(port),
        scope: g.scope,
        overrideDataDir: g.dataDir,
      });
      const shutdown = async () => {
        await app.close();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });

  program
    .command("mcp")
    .description("Start the Conflux v2 MCP server over stdio")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      await startMcpServer({ scope: g.scope, overrideDataDir: g.dataDir });
    });

  program
    .command("status")
    .description("Show probed local CLIs, projects, and active Agent Threads")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, (db) => {
        const out = {
          cli_probes: probeLocalClis(db, { force: true }),
          projects: listProjects(db),
          threads: listThreads(db),
        };
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      });
    });

  const projectCmd = program.command("project").description("Manage workspace projects");
  projectCmd
    .command("ls")
    .description("List registered projects")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, (db) => {
        process.stdout.write(`${JSON.stringify({ projects: listProjects(db) }, null, 2)}\n`);
      });
    });
  projectCmd
    .command("add <path>")
    .option("-n, --name <name>", "Display name")
    .description("Register a local project directory")
    .action(async (rootPath: string, cmdOpts: { name?: string }) => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, (db) => {
        const project = createProject(db, { root_path: rootPath, name: cmdOpts.name });
        process.stdout.write(`${JSON.stringify({ project }, null, 2)}\n`);
      });
    });

  const threadCmd = program.command("thread").description("Inspect Agent Threads");
  threadCmd
    .command("ls")
    .option("--project <id>", "Filter by project id")
    .description("List Agent Threads")
    .action(async (cmdOpts: { project?: string }) => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, (db) => {
        const threads = listThreads(db, {
          project_id: cmdOpts.project ? Number(cmdOpts.project) : undefined,
        });
        process.stdout.write(`${JSON.stringify({ threads }, null, 2)}\n`);
      });
    });

  const wfCmd = program.command("workflow").description("Manage multi-agent DAG workflows");
  wfCmd
    .command("ls")
    .description("List workflows")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, (db) => {
        process.stdout.write(`${JSON.stringify({ workflows: listWorkflows(db) }, null, 2)}\n`);
      });
    });
  wfCmd
    .command("run <workflowId>")
    .option("-i, --input <text>", "Run input text")
    .description("Start a workflow run")
    .action(async (wfId: string, cmdOpts: { input?: string }) => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, async (db) => {
        const run = await startWorkflowRun(db, Number(wfId), {
          input: cmdOpts.input,
          initiated_by: WEB_CONSOLE_ID,
        });
        process.stdout.write(`${JSON.stringify({ run }, null, 2)}\n`);
      });
    });
  wfCmd
    .command("status <runId>")
    .description("Inspect a workflow run")
    .action(async (runId: string) => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, (db) => {
        const run = getWorkflowRun(db, Number(runId));
        process.stdout.write(`${JSON.stringify({ run }, null, 2)}\n`);
      });
    });
  wfCmd
    .command("approve <stepId>")
    .option("--reject", "Reject instead of approve")
    .option("-c, --comment <text>", "Approval comment")
    .description("Approve or reject a workflow human_gate step")
    .action(async (stepId: string, cmdOpts: { reject?: boolean; comment?: string }) => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, async (db) => {
        const run = await approveHumanGate(db, Number(stepId), {
          approved: !cmdOpts.reject,
          comment: cmdOpts.comment,
        });
        process.stdout.write(`${JSON.stringify({ run }, null, 2)}\n`);
      });
    });

  program
    .command("handoff <fromThread> <toThread>")
    .option("-p, --prompt <text>", "Follow-up task prompt")
    .option("-n, --note <text>", "Handoff note")
    .description("Hand off thread context + pinned shared memory to another thread")
    .action(async (fromThread: string, toThread: string, cmdOpts: { prompt?: string; note?: string }) => {
      const g = program.opts<GlobalOpts>();
      await withDb(g, async (db) => {
        const res = await handoffContext(db, {
          from_thread: fromThread,
          to_thread: toThread,
          prompt: cmdOpts.prompt,
          note: cmdOpts.note,
        });
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      });
    });

  // ---- Original-Directory Hook & Idle Wakeup CLI ----

  const hookCmd = program.command("hook").description("Install or run original-directory CLI hooks");
  hookCmd
    .command("install <cli>")
    .option("--hub <url>", "Conflux Hub URL (auto-detects local LAN/Tailscale IP if omitted)")
    .description("Install Tier-1 native CLI hooks (claude | codex | agy)")
    .action((cliArg: string, cmdOpts: { hub?: string }) => {
      const normalized = cliArg.trim().toLowerCase();
      if (normalized !== "claude" && normalized !== "codex" && normalized !== "agy") {
        throw new Error(`Unsupported CLI '${cliArg}'. Expected: claude | codex | agy`);
      }
      const hubUrl = cmdOpts.hub?.trim() || detectLocalNetworkInfo(resolveHttpPort()).hub_url;
      const result = installCliHook(normalized as HookTargetCli, { hubUrl });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  hookCmd
    .command("check")
    .option("--hub <url>", "Conflux Hub URL", `http://127.0.0.1:${resolveHttpPort()}`)
    .option("--runtime <runtime>", "CLI runtime: claude | codex | antigravity", "claude")
    .option("--session-id <id>", "Explicit session_id (falls back to stdin hook JSON)")
    .option("--cwd <dir>", "Explicit working directory (falls back to stdin hook JSON or cwd)")
    .option("--offline", "Mark this session offline (for SessionEnd hooks)")
    .description("Heartbeat 1:1 external session and check pending Conflux peer calls")
    .action(
      async (cmdOpts: {
        hub: string;
        runtime: string;
        sessionId?: string;
        cwd?: string;
        offline?: boolean;
      }) => {
        let stdinPayload: Record<string, unknown> = {};
        if (!process.stdin.isTTY) {
          try {
            const raw = readFileSync(0, "utf8").trim();
            if (raw) stdinPayload = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // non-JSON or empty stdin
          }
        }
        const sessionId =
          cmdOpts.sessionId?.trim() ||
          (typeof stdinPayload.session_id === "string" ? stdinPayload.session_id.trim() : "") ||
          process.env.CONFLUX_SESSION_ID?.trim() ||
          "";
        const cwd =
          cmdOpts.cwd?.trim() ||
          (typeof stdinPayload.cwd === "string" ? stdinPayload.cwd.trim() : "") ||
          process.cwd();
        if (!sessionId) return;

        const hub = cmdOpts.hub.replace(/\/+$/, "");
        if (cmdOpts.offline) {
          await fetch(`${hub}/mesh/peers/offline`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId }),
          }).catch(() => {});
          return;
        }

        const runtime = isValidRuntime(cmdOpts.runtime) ? cmdOpts.runtime : "claude";
        try {
          const res = await fetch(`${hub}/mesh/peers/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: sessionId,
              cwd,
              host: hostname() || "localhost",
              runtime,
            }),
          });
          if (!res.ok) return;
          const data = (await res.json()) as {
            inbox?: Array<{ id: number; from_name?: string; question: string; context?: string }>;
          };
          const inbox = data.inbox ?? [];
          if (inbox.length > 0) {
            const summary = inbox
              .map(
                (m) =>
                  `[Conflux 来电 #${m.id} 来自 ${m.from_name ?? "peer"}] ${m.question}${
                    m.context ? `\n附带上下文:\n${m.context}` : ""
                  }`,
              )
              .join("\n\n");
            process.stdout.write(
              `${JSON.stringify({
                decision: "block",
                reason: `你有 ${inbox.length} 条未回复的 Conflux 同伴来电，请在当前上下文中回答并调用 reply_peer 回复：\n\n${summary}`,
              })}\n`,
            );
          }
        } catch {
          // Hub unreachable — fail silently so user CLI stays snappy
        }
      },
    );

  program
    .command("wake <sessionId>")
    .requiredOption("--cwd <dir>", "Exact original working directory (never spawns orphan headless threads)")
    .option("--runtime <runtime>", "Target CLI runtime: claude | codex | antigravity", "claude")
    .requiredOption("-p, --prompt <text>", "Prompt to deliver into the resumed original session")
    .description("Tier-2 idle wakeup: cd into original directory and resume exact session_id")
    .action(
      (
        sessionId: string,
        cmdOpts: { cwd: string; runtime: string; prompt: string },
      ) => {
        const runtime = isValidRuntime(cmdOpts.runtime) ? cmdOpts.runtime : "claude";
        const result = executeOriginalDirectoryWake({
          runtime,
          sessionId,
          cwd: cmdOpts.cwd,
          prompt: cmdOpts.prompt,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) process.exitCode = 1;
      },
    );

  return program;
}
