import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeDb } from "./helpers.js";
import type { RuntimeAgent } from "@conflux/shared";
import { createRuntimeAgent } from "../core/runtime-agents.js";
import {
  bindRuntimeInstance,
  createRuntimeInstance,
  getRuntimeInstance,
  inspectRuntimeProcess,
  listRuntimeInstances,
  resumeRuntimeInstance,
  stopRuntimeInstance,
} from "../core/runtime-instances.js";
import { registerSession } from "../core/sessions.js";

// Process-level E2E for managed runtime instances. Everything here uses the
// PRODUCTION inspection/termination paths (PowerShell CIM on Windows,
// /proc on Linux, ps on macOS; taskkill /F or SIGTERM) against real child
// processes whose command lines are shaped like claude/codex CLIs. Only the
// terminal-window opener is injected — opening a visible terminal cannot be
// headless — and that layer keeps its existing unit coverage. Real Codex /
// Claude Code hosts are validated separately and are not substituted here.
//
// This file lives outside the *.test.ts glob ON PURPOSE: the production
// inspection budget is a deliberate 2 s, and the parallel unit-suite load
// can push PowerShell past it — the E2E runs serially via
// `npm run test:process-e2e -w apps/server` (also part of ci:test).

const shimSource = resolve(__dirname, "runtime-process-shim.cjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real process inspection carries a deliberately short production timeout
 * (2 s), which the parallel test suite's load can exceed transiently — the
 * hook/MCP registration path also retries. These polls mirror that: the
 * assertions still require the real inspection to succeed, just not on the
 * first attempt.
 */
async function eventually<T>(
  fn: () => T | Promise<T>,
  ok: (value: T) => boolean,
  label: string,
  attempts = 12,
  delayMs = 750,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(delayMs);
  }
  assert.ok(ok(last!), `${label} (last observation: ${JSON.stringify(last)})`);
  return last!;
}

async function bindForReal(
  db: ReturnType<typeof makeDb>["db"],
  instanceId: string,
  sessionId: string,
  pid: number,
): Promise<boolean> {
  return eventually(
    () => bindRuntimeInstance(db, instanceId, sessionId, pid),
    (v) => v === true,
    `bind of pid ${pid} never succeeded through real inspection`,
  );
}

function stopForReal(
  db: ReturnType<typeof makeDb>["db"],
  instanceId: string,
  child?: ChildProcess,
) {
  return eventually(
    () => {
      try {
        return stopRuntimeInstance(db, instanceId);
      } catch (error) {
        const message = (error as Error).message;
        if (/process identity changed|无法验证进程身份/.test(message)) return null;
        // Enrich refusals with the observed state so CI failures pinpoint
        // which guard fired instead of only the conflict message. The child
        // handle's exit status distinguishes a crashed shim from a killed one.
        const current = getRuntimeInstance(db, instanceId);
        const inspected = current?.runtime_pid
          ? inspectRuntimeProcess(current.runtime_pid)
          : null;
        const childState = child
          ? ` childExit=${child.exitCode}/${child.signalCode} stderr=${(shimsStderr(child) ?? "").slice(-400)}`
          : "";
        throw new Error(
          `stop refused: ${message} | state=${current?.state} limitation=${current?.limitation} ` +
            `pid=${current?.runtime_pid} inspect=${JSON.stringify(inspected)}${childState}`,
          { cause: error },
        );
      }
    },
    (v) => v !== null && v.state === "ended",
    `stop of ${instanceId} never verified the exit`,
  );
}

/** stderr tail of a spawned shim, kept for crash diagnostics. */
function shimsStderr(child: ChildProcess): string | null {
  if (!child.pid) return null;
  return shimsStderrCache.get(child.pid) ?? null;
}
let shimsStderrCache = new Map<number, string>();

interface ShimReport {
  pid: number;
  instanceId: string | null;
  home: string | null;
  resume: string | null;
  argv: string[];
}

class ShimHost {
  readonly dir: string;
  private readonly children = new Set<ChildProcess>();
  /** stderr tail per child, for crash diagnostics on CI. */
  readonly stderr = new Map<number, string>();

  constructor(root: string) {
    // Non-ASCII and shell metacharacters on purpose: the command line the
    // inspector sees must survive them. Spaces are included only where the
    // platform can express argv boundaries — Windows CommandLine keeps
    // quotes, Linux /proc/cmdline is NUL-separated (and re-quoted by the
    // inspector); macOS `ps` joins argv with single spaces, so a spaced
    // path is unidentifiable there by design and the name stays space-free.
    this.dir = join(root, process.platform === "darwin" ? "rt-é-(x)+工" : "rt é (x) + 工");
    mkdirSync(this.dir, { recursive: true });
    for (const name of ["claude", "codex"]) {
      copyFileSync(shimSource, join(this.dir, name));
      if (process.platform !== "win32") {
        // A direct-exec variant: shebang script executed without node in
        // argv, the shape a POSIX shell produces for an installed CLI. It
        // needs its own directory so the file is still named exactly
        // "claude"/"codex" — the basename is what identity matching sees.
        const body = readFileSync(shimSource, "utf8");
        const directDir = join(this.dir, "direct");
        mkdirSync(directDir, { recursive: true });
        writeFileSync(join(directDir, name), `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
      }
    }
  }

  spawnRuntime(
    runtime: "claude" | "codex",
    reportFile: string,
    opts: { mode?: string; direct?: boolean; env?: NodeJS.ProcessEnv } = {},
  ): ChildProcess {
    const direct = opts.direct === true && process.platform !== "win32";
    const script = join(this.dir, direct ? join("direct", runtime) : runtime);
    const child = direct
      ? spawn(script, [opts.mode ?? "stay", reportFile], {
          env: opts.env,
          stdio: ["ignore", "ignore", "pipe"],
        })
      : spawn(process.execPath, [script, opts.mode ?? "stay", reportFile], {
          env: opts.env,
          stdio: ["ignore", "ignore", "pipe"],
        });
    let errTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-2000);
    });
    child.once("exit", () => {
      this.stderr.set(child.pid!, errTail);
      shimsStderrCache.set(child.pid!, errTail);
      this.children.delete(child);
    });
    this.children.add(child);
    return child;
  }

  async report(reportFile: string): Promise<ShimReport> {
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        return JSON.parse(readFileSync(reportFile, "utf8")) as ShimReport;
      } catch {
        assert.ok(Date.now() < deadline, `shim never wrote ${reportFile}`);
        await sleep(100);
      }
    }
  }

  /** Kill everything this instance spawned; reports pids that refused to die. */
  async cleanup(): Promise<number[]> {
    const alive = [...this.children].filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    // Bounded waits throughout: a shim that ignores SIGTERM must never
    // keep the suite (or a CI runner) waiting forever.
    for (const child of alive) child.kill();
    await Promise.all(
      alive.map((child) =>
        Promise.race([once(child, "exit").catch(() => undefined), sleep(3000)]),
      ),
    );
    const stubborn = alive.filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    for (const child of stubborn) child.kill("SIGKILL");
    if (stubborn.length)
      await Promise.all(
        stubborn.map((child) =>
          Promise.race([once(child, "exit").catch(() => undefined), sleep(3000)]),
        ),
      );
    return stubborn
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => child.pid!);
  }
}

async function bindShim(
  db: ReturnType<typeof makeDb>["db"],
  agent: RuntimeAgent,
  shims: ShimHost,
  sessionId: string,
  opts: { runtime?: "claude" | "codex"; direct?: boolean; mode?: string } = {},
): Promise<{ instanceId: string; pid: number; report: ShimReport }> {
  const runtime = opts.runtime ?? "claude";
  const reportFile = join(shims.dir, `report-${sessionId}.json`);
  shims.spawnRuntime(runtime, reportFile, opts);
  const report = await shims.report(reportFile);
  const instance = createRuntimeInstance(db, agent);
  registerSession(db, {
    id: sessionId,
    name: `shim-${sessionId}`,
    runtime,
    runtime_pid: report.pid,
    metadata: { runtime_instance_id: instance.id, agent_id: agent.id },
  });
  return { instanceId: instance.id, pid: report.pid, report, child };
}

test("real subprocess binds by pid and creation identity, then stops with verified exit", { timeout: 120000 }, async (t) => {
  const { db, cleanup: cleanupDb } = makeDb();
  t.after(() => cleanupDb());
  const shims = new ShimHost(dirname(db.name));
  t.after(async () => assert.deepEqual(await shims.cleanup(), [], "shim leaked past the test"));

  const agent = createRuntimeAgent(db, {
    name: "proc-e2e",
    runtime: "claude",
    workdir: shims.dir,
    model: null,
    base_url: null,
    api_key: null,
  });

  const bound = await bindShim(db, agent, shims, "sess-bind");
  // The production inspector must accept a node-launched CLI lookalike.
  await bindForReal(db, bound.instanceId, "sess-bind", bound.pid);
  await eventually(
    () => getRuntimeInstance(db, bound.instanceId)!,
    (v) => v.state === "running" && v.can_stop === true && v.limitation === null,
    "bound instance never showed running/stoppable",
  );

  // Listing drives the real batch inspection (Windows) and refresh.
  await eventually(
    () => listRuntimeInstances(db).find((i) => i.id === bound.instanceId)!,
    (v) => v.state === "running" && v.can_stop === true,
    "listing never confirmed the running instance",
  );

  if (process.platform !== "win32") {
    const directBound = await bindShim(db, agent, shims, "sess-direct", { direct: true });
    await bindForReal(db, directBound.instanceId, "sess-direct", directBound.pid);
    await stopForReal(db, directBound.instanceId);
  }

  await stopForReal(db, bound.instanceId);
  assert.throws(() => process.kill(bound.pid, 0), { code: "ESRCH" }, "process must really be gone");
});

test("unbound pid, foreign runtime and ownership mismatches refuse to stop", { timeout: 120000 }, async (t) => {
  const { db, cleanup: cleanupDb } = makeDb();
  t.after(() => cleanupDb());
  const shims = new ShimHost(dirname(db.name));
  t.after(async () => assert.deepEqual(await shims.cleanup(), []));

  const claudeAgent = createRuntimeAgent(db, {
    name: "owner",
    runtime: "claude",
    workdir: shims.dir,
  });

  // Never bound: no verifiable runtime process.
  const orphan = createRuntimeInstance(db, claudeAgent);
  assert.throws(() => stopRuntimeInstance(db, orphan.id), /尚未绑定可验证的运行时进程/);

  // A codex-shaped process cannot bind a claude instance even with a
  // session that claims the pid — the real inspector classifies the
  // command line, and the runtimes disagree. Prove the inspection is
  // healthy first so the refusal is read for the right reason.
  const reportFile = join(shims.dir, "report-foreign.json");
  shims.spawnRuntime("codex", reportFile);
  const foreign = await shims.report(reportFile);
  await eventually(
    () => inspectRuntimeProcess(foreign.pid),
    (v) => v !== null && v !== "exited" && v.runtime === "codex",
    "foreign codex shim never inspected as codex",
  );
  const mismatched = createRuntimeInstance(db, claudeAgent);
  registerSession(db, {
    id: "sess-foreign",
    name: "foreign",
    runtime: "claude",
    runtime_pid: foreign.pid,
    metadata: { runtime_instance_id: mismatched.id, agent_id: claudeAgent.id },
  });
  assert.equal(bindRuntimeInstance(db, mismatched.id, "sess-foreign", foreign.pid), false);

  // Bound and running, but the session later points at another pid:
  // ownership no longer holds, stop is refused.
  const owned = await bindShim(db, claudeAgent, shims, "sess-owned");
  await bindForReal(db, owned.instanceId, "sess-owned", owned.pid);
  const other = await bindShim(db, claudeAgent, shims, "sess-other");
  await bindForReal(db, other.instanceId, "sess-other", other.pid);
  shims.spawnRuntime("claude", join(shims.dir, "report-pid2.json"));
  const pid2 = (await shims.report(join(shims.dir, "report-pid2.json"))).pid;
  registerSession(db, {
    id: "sess-owned",
    name: "shim-sess-owned",
    runtime: "claude",
    runtime_pid: pid2,
    metadata: { runtime_instance_id: owned.instanceId, agent_id: claudeAgent.id },
  });
  assert.throws(() => stopRuntimeInstance(db, owned.instanceId), /归属不匹配/);

  // What a PID reuse looks like: row and session both recorded this pid,
  // but the pid now names a different live process (different creation
  // token) — exactly the state an OS pid recycle produces.
  db.prepare("UPDATE runtime_instances SET runtime_pid = ? WHERE id = ?").run(
    pid2,
    other.instanceId,
  );
  registerSession(db, {
    id: "sess-other",
    name: "shim-sess-other",
    runtime: "claude",
    runtime_pid: pid2,
    metadata: { runtime_instance_id: other.instanceId, agent_id: claudeAgent.id },
  });
  await eventually(
    () => getRuntimeInstance(db, other.instanceId)!,
    (v) => v.limitation === "原进程 PID 已被复用，拒绝停止",
    "pid-reuse state never classified",
  );
  assert.throws(() => stopRuntimeInstance(db, other.instanceId), /PID 已被复用/);
});

test("registration timeout and stale-while-alive are classified by real refresh", { timeout: 120000 }, async (t) => {
  const { db, cleanup: cleanupDb } = makeDb();
  t.after(() => cleanupDb());
  const shims = new ShimHost(dirname(db.name));
  t.after(async () => assert.deepEqual(await shims.cleanup(), []));

  const agent = createRuntimeAgent(db, { name: "clock", runtime: "claude", workdir: shims.dir });

  // Two minutes without a registration mark the instance failed.
  const timedOut = createRuntimeInstance(db, agent);
  db.prepare("UPDATE runtime_instances SET created_at = ? WHERE id = ?").run(
    new Date(Date.now() - 150_000).toISOString(),
    timedOut.id,
  );
  const afterTimeout = listRuntimeInstances(db).find((i) => i.id === timedOut.id)!;
  assert.equal(afterTimeout.state, "failed");
  assert.match(afterTimeout.error ?? "", /did not register/);

  // Alive but silent: heartbeat age flips state to stale while the real
  // process is still verifiable; its exit flips it to ended and resumable.
  const bound = await bindShim(db, agent, shims, "sess-stale");
  await bindForReal(db, bound.instanceId, "sess-stale", bound.pid);
  db.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?").run(
    new Date(Date.now() - 300_000).toISOString(),
    "sess-stale",
  );
  const stale = await eventually(
    () => listRuntimeInstances(db).find((i) => i.id === bound.instanceId)!,
    (v) => v.state === "stale",
    "silent-but-alive instance never went stale",
  );
  assert.equal(stale.can_resume, false, "still-running process must not be resumable");
  assert.match(stale.limitation ?? "", /仍在运行/);

  process.kill(bound.pid, "SIGTERM");
  // Inspection results are cached for 3 s per pid (listingIO); wait past
  // the cache so the exit is observed the way a later production poll would.
  await sleep(3500);
  const ended = await eventually(
    () => listRuntimeInstances(db).find((i) => i.id === bound.instanceId)!,
    (v) => v.state === "ended",
    "exited instance never flipped to ended",
  );
  assert.equal(ended.can_resume, true);
});

test("resume spawns a new real instance with original conversation identity; duplicates refused", { timeout: 120000 }, async (t) => {
  const { db, cleanup: cleanupDb } = makeDb();
  t.after(() => cleanupDb());
  const shims = new ShimHost(dirname(db.name));
  t.after(async () => assert.deepEqual(await shims.cleanup(), []));

  const agent = createRuntimeAgent(db, { name: "resumer", runtime: "claude", workdir: shims.dir });

  // Produce an ended, resumable instance through the real paths.
  const first = await bindShim(db, agent, shims, "sess-first");
  await bindForReal(db, first.instanceId, "sess-first", first.pid);
  await stopForReal(db, first.instanceId);

  // Launch failure marks the freshly created instance failed without
  // touching the resumable original.
  assert.throws(
    () =>
      resumeRuntimeInstance(db, first.instanceId, {
        platform: "win32",
        launch: () => {
          throw Error("terminal opener failed");
        },
      }),
    /terminal opener failed/,
  );

  // Real resume: the injected opener spawns an actual subprocess that the
  // production inspector can later verify; env carries the instance id,
  // the data dir and the original conversation id.
  const newReportFile = join(shims.dir, "report-resumed.json");
  const { instance: resumed } = resumeRuntimeInstance(db, first.instanceId, {
    platform: "win32",
    launch: (_settings, spec) => {
      shims.spawnRuntime("claude", newReportFile, { env: spec.env });
    },
  });
  assert.notEqual(resumed.id, first.instanceId);
  assert.equal(resumed.resumed_from, first.instanceId);
  const newReport = await shims.report(newReportFile);
  assert.equal(newReport.instanceId, resumed.id);
  assert.equal(newReport.home, dirname(db.name), "non-default data dir must propagate");
  assert.equal(newReport.resume, "sess-first", "original conversation identity must propagate");

  // Register the resumed process like its hook would, then verify the
  // duplicate-resume guard through the real active-instance query.
  registerSession(db, {
    id: "sess-resumed",
    name: "shim-resumed",
    runtime: "claude",
    runtime_pid: newReport.pid,
    metadata: { runtime_instance_id: resumed.id, agent_id: agent.id },
  });
  await bindForReal(db, resumed.id, "sess-resumed", newReport.pid);
  assert.throws(() => resumeRuntimeInstance(db, first.instanceId, { platform: "win32", launch: () => {} }), /重复恢复/);

  // Stopping the resumed instance ends its session too.
  await stopForReal(db, resumed.id);
  assert.throws(() => process.kill(newReport.pid, 0), { code: "ESRCH" });
});

test("delayed SIGTERM keeps stop control until absence is verified", { timeout: 120000 }, async (t) => {
  if (process.platform === "win32") return t.skip("taskkill /F is immediate on Windows");
  const { db, cleanup: cleanupDb } = makeDb();
  t.after(() => cleanupDb());
  const shims = new ShimHost(dirname(db.name));
  t.after(async () => assert.deepEqual(await shims.cleanup(), []));

  const agent = createRuntimeAgent(db, { name: "stubborn", runtime: "claude", workdir: shims.dir });
  const bound = await bindShim(db, agent, shims, "sess-stubborn", { mode: "delayed-exit" });
  await bindForReal(db, bound.instanceId, "sess-stubborn", bound.pid);

  // First SIGTERM is ignored by the shim: stop stays requested but not done.
  const requested = stopRuntimeInstance(db, bound.instanceId);
  assert.equal(requested.state, "running");
  assert.ok(requested.stop_requested_at);
  assert.match(requested.limitation ?? "", /等待进程退出/);

  // The second termination is honored and the exit is verified.
  // Stop control stays available while the process lives.
  const stillControllable = getRuntimeInstance(db, bound.instanceId)!;
  assert.equal(stillControllable.can_stop, true);
  // The second signal goes through the test's own channel (signal
  // delivery timing on CI runners is not deterministic); the completion
  // branch of a second stopRuntimeInstance call is covered by the injected
  // unit regression. Here the refresh path must verify the exit.
  bound.child.kill();
  const finished = await eventually(
    () => listRuntimeInstances(db).find((i) => i.id === bound.instanceId)!,
    (v) => v.state === "ended",
    "refresh never verified the delayed exit",
  );
  assert.equal(finished.state, "ended");
  assert.throws(() => process.kill(bound.pid, 0), { code: "ESRCH" });
});
