import { Command } from "commander";
import { APP_VERSION } from "../version.js";
import { resolveConfig, resolveHttpHost, resolveHttpPort, type Scope } from "../config.js";
import { openDb, stopWalCheckpoint } from "../core/db.js";
import { startHttpServer } from "../http/server.js";
import { startMcpServer } from "../mcp/server.js";
import { createProject, listProjects } from "../core/projects.js";
import { listThreads } from "../core/threads/store.js";
import { probeLocalClis } from "../core/cli-probe.js";
import { approveHumanGate, getWorkflowRun, listWorkflows, startWorkflowRun } from "../core/workflows.js";
import { handoffContext } from "../core/handoff.js";
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

  return program;
}
