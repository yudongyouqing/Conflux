import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers.js";
import {
  createRuntimeAgent,
  hasActiveRun,
  startRuntimeAgent,
  buildManagedRuntimeCommand,
  managedMcpLaunch,
} from "../core/runtime-agents.js";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { buildLaunchPlan } from "../core/terminal.js";
import { registerSession, endSession, mergeSessionMeta } from "../core/sessions.js";
import { askSession, getMessage } from "../core/messages.js";
import { pushMailTyped } from "../core/mail-push.js";
import {
  createRuntimeInstance,
  bindRuntimeInstance,
  getRuntimeInstance,
  listRuntimeInstances,
  stopRuntimeInstance,
  resumeRuntimeInstance,
} from "../core/runtime-instances.js";

test("managed launch persists a unique starting instance and tags the runtime environment", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "test", runtime: "claude" });
    let instanceId: string | undefined;
    const result = startRuntimeAgent(db, preset.id, {
      platform: "win32",
      launch: (_settings, input) => {
        instanceId = input.env?.CONFLUX_RUNTIME_INSTANCE_ID;
      },
    });
    assert.equal(result.instance.id, instanceId);
    assert.equal(result.instance.state, "starting");
    assert.equal(result.instance.runtime_pid, null);
    assert.equal(result.instance.can_stop, false);
    assert.equal(hasActiveRun(db, preset.id), true);
  } finally {
    cleanup();
  }
});

test("Codex launch explicitly configures its managed MCP identity without putting credentials in argv", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, {
      name: "codex",
      runtime: "codex",
      api_key: "argv-secret",
      extra_env: '{"PRIVATE_TOKEN":"extra-secret"}',
    });
    let command = "";
    const started = startRuntimeAgent(db, preset.id, {
      platform: "win32",
      launch: (_settings, input) => {
        command = Object.entries(input.env ?? {})
          .filter(([key]) => key.startsWith("CONFLUX_RUNTIME_ARG_"))
          .map(([, value]) => value)
          .join(" ");
        assert.equal(input.env?.CONFLUX_HOME, dirname(db.name));
      },
    });
    assert.match(command, /mcp_servers\.conflux\.env\.CONFLUX_RUNTIME_INSTANCE_ID=/);
    assert.ok(command.includes(started.instance.id));
    assert.match(command, /mcp_servers\.conflux\.command=/);
    assert.match(command, /--data-dir/);
    assert.equal(command.includes("argv-secret"), false);
    assert.equal(command.includes("extra-secret"), false);
    registerSession(db, {
      id: "codex-mcp",
      name: "codex",
      runtime: "codex",
      runtime_pid: 456,
      metadata: {
        temp: true,
        runtime_instance_id: started.instance.id,
        agent_id: preset.id,
        codex_session_id: "native-thread",
      },
    });
    bindRuntimeInstance(db, started.instance.id, "codex-mcp", 456, {
      inspect: () => ({ runtime: "codex", token: "codex-created" }),
    });
    endSession(db, "codex-mcp");
    let resumeSeed: string | undefined;
    resumeRuntimeInstance(db, started.instance.id, {
      inspect: () => "exited",
      platform: "win32",
      launch: (_settings, input) => {
        command = Object.entries(input.env ?? {})
          .filter(([key]) => key.startsWith("CONFLUX_RUNTIME_ARG_"))
          .map(([, value]) => value)
          .join(" ");
        resumeSeed = input.env?.CONFLUX_RESUME_SESSION_ID;
      },
    });
    assert.match(command, /resume.*native-thread/);
    assert.equal(resumeSeed, "native-thread");
    assert.match(command, /mcp_servers\.conflux\.env\.CONFLUX_RESUME_SESSION_ID=/);
  } finally {
    cleanup();
  }
});

test("a managed tmux target remains unique and accepts mail while its agent is busy", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "tmux", runtime: "codex" });
    let target: string | undefined;
    startRuntimeAgent(db, preset.id, {
      platform: "darwin",
      launch: (_settings, input) => {
        target = input.env?.CONFLUX_TMUX_SESSION;
      },
    });
    assert.match(target!, /^conflux\/agent-1-/);
    registerSession(db, { id: "sender", name: "sender" });
    registerSession(db, {
      id: "agent-target",
      name: "agent",
      runtime: "codex",
      metadata: { agent_id: preset.id, tmux_session: target, busy: true },
    });
    const message = askSession(db, {
      from_session: "sender",
      to_session: "agent-target",
      question: "receive while busy",
    });
    let sentTo: string | undefined;
    const result = pushMailTyped(db, "agent-target", {
      available: () => true,
      alive: (name) => name === target,
      send: (name) => {
        sentTo = name;
        return true;
      },
      paneForPid: () => null,
      launch: () => false,
      capture: () => "",
    });
    assert.equal(result.pushed, true);
    assert.equal(sentTo, target);
    assert.equal(getMessage(db, message.id)?.status, "seen");
  } finally {
    cleanup();
  }
});

test("resume refuses deleted presets, changed credentials, and unverifiable live ownership", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, {
      name: "snapshot",
      runtime: "claude",
      api_key: "original-credential",
    });
    const instance = createRuntimeInstance(db, preset);
    registerSession(db, {
      id: "resume-owner",
      name: "owner",
      runtime: "claude",
      runtime_pid: 777,
      metadata: { runtime_instance_id: instance.id, agent_id: preset.id },
    });
    bindRuntimeInstance(db, instance.id, "resume-owner", 777, {
      inspect: () => ({ runtime: "claude", token: "creation" }),
    });
    endSession(db, "resume-owner");
    const launch = () => assert.fail("must not launch");
    assert.throws(() => resumeRuntimeInstance(db, instance.id, { inspect: () => null, launch }), {
      statusCode: 409,
    });
    db.prepare("UPDATE runtime_agents SET api_key = 'changed' WHERE id = ?").run(preset.id);
    assert.throws(
      () => resumeRuntimeInstance(db, instance.id, { inspect: () => "exited", launch }),
      { statusCode: 409 },
    );
    db.prepare("DELETE FROM runtime_agents WHERE id = ?").run(preset.id);
    assert.throws(
      () => resumeRuntimeInstance(db, instance.id, { inspect: () => "exited", launch }),
      { statusCode: 409 },
    );
  } finally {
    cleanup();
  }
});

test("stop requires instance ownership, current session PID and unchanged process creation identity", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "test", runtime: "claude" });
    const instance = createRuntimeInstance(db, preset);
    registerSession(db, {
      id: "owned",
      name: "owned",
      runtime: "claude",
      runtime_pid: 123,
      metadata: { runtime_instance_id: instance.id, agent_id: preset.id },
    });
    let alive = true;
    const inspect = () =>
      alive ? { runtime: "claude" as const, token: "creation-1" } : ("exited" as const);
    assert.equal(bindRuntimeInstance(db, instance.id, "owned", 123, { inspect }), true);
    const killed: number[] = [];
    assert.throws(
      () =>
        stopRuntimeInstance(db, instance.id, {
          inspect: () => ({ runtime: "claude", token: "reused" }),
          terminate: (pid) => killed.push(pid),
        }),
      { statusCode: 409 },
    );
    mergeSessionMeta(db, "owned", { runtime_instance_id: "unowned" });
    assert.throws(
      () => stopRuntimeInstance(db, instance.id, { inspect, terminate: (pid) => killed.push(pid) }),
      { statusCode: 409 },
    );
    assert.equal(killed.length, 0);
    mergeSessionMeta(db, "owned", { runtime_instance_id: instance.id });
    const delayed = stopRuntimeInstance(db, instance.id, { inspect, terminate: () => undefined });
    assert.equal(delayed.state, "running");
    assert.equal(delayed.can_stop, true);
    assert.match(delayed.limitation!, /等待进程退出/);
    const stopped = stopRuntimeInstance(db, instance.id, {
      inspect,
      terminate: (pid) => {
        killed.push(pid);
        alive = false;
      },
    });
    assert.deepEqual(killed, [123]);
    assert.equal(stopped.state, "ended");
  } finally {
    cleanup();
  }
});

test("starting and discovered sessions cannot be stopped, and unverified PID cannot bind", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "test", runtime: "codex" });
    const instance = createRuntimeInstance(db, preset);
    assert.throws(
      () => stopRuntimeInstance(db, instance.id, { terminate: () => assert.fail("must not kill") }),
      { statusCode: 409 },
    );
    registerSession(db, {
      id: "discovered",
      name: "discovered",
      runtime: "codex",
      runtime_pid: 77,
    });
    assert.equal(
      bindRuntimeInstance(db, instance.id, "discovered", 77, {
        inspect: () => ({ runtime: "codex", token: "creation" }),
      }),
      false,
    );
    assert.equal(getRuntimeInstance(db, instance.id)?.runtime_pid, null);
  } finally {
    cleanup();
  }
});

test("resume snapshots the original preset, uses the original conversation and rejects duplicate resumes", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, {
      name: "test",
      runtime: "claude",
      model: "original",
      api_key: "test-secret",
      instructions: "retain me",
    });
    const instance = createRuntimeInstance(db, preset);
    registerSession(db, {
      id: "conversation",
      name: "owned",
      runtime: "claude",
      runtime_pid: 123,
      metadata: { runtime_instance_id: instance.id, agent_id: preset.id },
    });
    bindRuntimeInstance(db, instance.id, "conversation", 123, {
      inspect: () => ({ runtime: "claude", token: "creation" }),
    });
    endSession(db, "conversation");
    db.prepare(
      "UPDATE runtime_agents SET model = 'changed', instructions = 'changed' WHERE id = ?",
    ).run(preset.id);
    let command = "";
    let key: string | undefined;
    const options = {
      platform: "win32" as const,
      inspect: () => "exited" as const,
      launch: (_settings: unknown, input: { command: string; env?: NodeJS.ProcessEnv }) => {
        command = Object.entries(input.env ?? {})
          .filter(([key]) => key.startsWith("CONFLUX_RUNTIME_ARG_"))
          .map(([, value]) => value)
          .join(" ");
        key = input.env?.ANTHROPIC_AUTH_TOKEN;
      },
    };
    const resumed = resumeRuntimeInstance(db, instance.id, options);
    assert.notEqual(resumed.instance.id, instance.id);
    assert.equal(resumed.instance.resumed_from, instance.id);
    assert.match(command, /--resume.*conversation/);
    assert.match(command, /original/);
    assert.match(command, /retain me/);
    assert.equal(key, "test-secret");
    assert.throws(() => resumeRuntimeInstance(db, instance.id, options), { statusCode: 409 });
    assert.equal(
      JSON.stringify(listRuntimeInstances(db, { inspect: () => null })).includes("test-secret"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("stale and unregistered timed-out resumes retain their conversation reservation", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "lineage", runtime: "claude" });
    const original = createRuntimeInstance(db, preset);
    registerSession(db, {
      id: "original",
      name: "original",
      runtime: "claude",
      runtime_pid: 111,
      metadata: { runtime_instance_id: original.id, agent_id: preset.id },
    });
    bindRuntimeInstance(db, original.id, "original", 111, {
      inspect: () => ({ runtime: "claude", token: "original" }),
    });
    const inspect = (pid: number) =>
      pid === 111 ? ("exited" as const) : { runtime: "claude" as const, token: "resumed" };
    const resumed = resumeRuntimeInstance(db, original.id, {
      inspect,
      launch: () => undefined,
      platform: "win32",
    });
    db.prepare(
      "UPDATE runtime_instances SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(resumed.instance.id);
    listRuntimeInstances(db, { inspect });
    assert.equal(getRuntimeInstance(db, resumed.instance.id, { inspect })?.state, "failed");
    assert.throws(
      () =>
        resumeRuntimeInstance(db, original.id, {
          inspect,
          launch: () => assert.fail("must not duplicate"),
          platform: "win32",
        }),
      { statusCode: 409 },
    );
    registerSession(db, {
      id: "resumed",
      name: "resumed",
      runtime: "claude",
      runtime_pid: 222,
      metadata: { runtime_instance_id: resumed.instance.id, agent_id: preset.id },
    });
    assert.equal(bindRuntimeInstance(db, resumed.instance.id, "resumed", 222, { inspect }), true);
    db.prepare(
      "UPDATE sessions SET last_heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = 'resumed'",
    ).run();
    listRuntimeInstances(db, { inspect });
    assert.equal(getRuntimeInstance(db, resumed.instance.id, { inspect })?.state, "stale");
    assert.throws(
      () =>
        resumeRuntimeInstance(db, original.id, {
          inspect,
          launch: () => assert.fail("must not duplicate"),
          platform: "win32",
        }),
      { statusCode: 409 },
    );
  } finally {
    cleanup();
  }
});

test("managed MCP uses a runnable source loader and the same database as runtime hooks", () => {
  const { db, cleanup } = makeDb();
  try {
    const launch = managedMcpLaunch(db);
    assert.equal(launch.args[launch.args.indexOf("--data-dir") + 1], dirname(db.name));
    const loaderArgs = launch.args[0] === "--import" ? launch.args.slice(0, 2) : [];
    const output = execFileSync(
      launch.command,
      [...loaderArgs, "-e", "process.stdout.write('loader-ok')"],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    assert.equal(output, "loader-ok");
  } finally {
    cleanup();
  }
});

test(
  "Windows managed command preserves literal argv through cmd without shell expansion",
  { skip: process.platform !== "win32" },
  () => {
    const env = { ...process.env };
    const expected = [
      "a%SYSTEMDRIVE%b",
      'a"&b',
      "a!USERPROFILE!b",
      "a|b",
      "a^b",
      "C:\\quoted path\\",
    ];
    const command = buildManagedRuntimeCommand(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...expected],
      env,
      "win32",
    );
    const output = spawnSync(process.env.comspec ?? "cmd.exe", ["/d", "/s", "/c", command], {
      env,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), expected);
  },
);

test(
  "PowerShell terminal launches managed commands with literal argv",
  { skip: process.platform !== "win32" },
  () => {
    const env = { ...process.env };
    const expected = [
      "a%SYSTEMDRIVE%b",
      'a"&b',
      "a!USERPROFILE!b",
      "a|b",
      "a^b",
      "C:\\quoted path\\",
    ];
    const command = buildManagedRuntimeCommand(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...expected],
      env,
      "win32",
    );
    const plan = buildLaunchPlan(
      { terminal: "powershell" },
      { command, env, title: "probe" },
      { platform: "win32" },
    );
    const powershell = plan.find((candidate) => candidate.file === "powershell.exe")!;
    const output = spawnSync(
      powershell.file,
      powershell.args.filter((arg) => arg !== "-NoExit"),
      { env, encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), expected);
  },
);
