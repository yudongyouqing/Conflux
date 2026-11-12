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
import { registerSession, endSession, mergeSessionMeta, getSession } from "../core/sessions.js";
import { askSession, getMessage } from "../core/messages.js";
import { pushMailTyped } from "../core/mail-push.js";
import {
  type MacosProcessFields,
  macosProcessToken,
  parseMacosPs,
  parseLegacyMacosToken,
  classifyProcessToken,
  createRuntimeInstance,
  bindRuntimeInstance,
  getRuntimeInstance,
  listRuntimeInstances,
  stopRuntimeInstance,
  resumeRuntimeInstance,
} from "../core/runtime-instances.js";

test("managed launch persists a unique starting instance and tags the runtime environment", async () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "test", runtime: "claude" });
    let instanceId: string | undefined;
    const result = await startRuntimeAgent(db, preset.id, {
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

test("Codex launch explicitly configures its managed MCP identity without putting credentials in argv", async () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, {
      name: "codex",
      runtime: "codex",
      api_key: "argv-secret",
      extra_env: '{"PRIVATE_TOKEN":"extra-secret"}',
    });
    let command = "";
    const started = await startRuntimeAgent(db, preset.id, {
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
    await resumeRuntimeInstance(db, started.instance.id, {
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

test("resume refuses deleted presets, changed credentials, and unverifiable live ownership", async () => {
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
    await assert.rejects(resumeRuntimeInstance(db, instance.id, { inspect: () => null, launch }), {
      statusCode: 409,
    });
    db.prepare("UPDATE runtime_agents SET api_key = 'changed' WHERE id = ?").run(preset.id);
    await assert.rejects(
      resumeRuntimeInstance(db, instance.id, { inspect: () => "exited", launch }),
      { statusCode: 409 },
    );
    db.prepare("DELETE FROM runtime_agents WHERE id = ?").run(preset.id);
    await assert.rejects(
      resumeRuntimeInstance(db, instance.id, { inspect: () => "exited", launch }),
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

test("macOS token relations: same / replaced / changed are distinguished", () => {
  const fields = (cpuCentis: number): MacosProcessFields => ({
    lstart: "Mon Nov  2 03:25:13 2026",
    ppid: "45",
    pgid: "44",
    sess: "44",
    cpuCentis,
    command: "node /opt/claude --resume x",
  });
  const bound = macosProcessToken(123, fields(250));

  // same
  assert.equal(classifyProcessToken(bound, macosProcessToken(123, fields(250))), "same");
  assert.equal(classifyProcessToken(bound, macosProcessToken(123, fields(900))), "same");

  // replaced: confirmed new generation
  assert.equal(
    classifyProcessToken(bound, macosProcessToken(123, fields(12))),
    "replaced",
    "a same-second reused pid with less accumulated CPU than the bind floor is a replacement",
  );
  assert.equal(
    classifyProcessToken(bound, macosProcessToken(123, { ...fields(900), lstart: "Mon Nov  2 03:25:14 2026" })),
    "replaced",
    "a different creation second is a replacement",
  );
  // Non-macOS tokens (no floor segment) are pure creation stamps.
  assert.equal(classifyProcessToken("boot-id:12345", "boot-id:12345"), "same");
  assert.equal(classifyProcessToken("boot-id:12345", "boot-id:12346"), "replaced");
  assert.equal(classifyProcessToken("macos:1:a:2:3:4:deadbeef:cpu>=10", "boot-id:12345"), "replaced");

  // changed: same generation (same lstart, floor satisfied) but a MUTABLE
  // descriptor field differs — the process is ALIVE, re-parented/retitled.
  assert.equal(
    classifyProcessToken(bound, macosProcessToken(123, { ...fields(900), ppid: "1" })),
    "changed",
    "re-parenting (parent exited, ppid now 1) is a live process, not an exit",
  );
  assert.equal(
    classifyProcessToken(bound, macosProcessToken(123, { ...fields(900), pgid: "99" })),
    "changed",
  );
  assert.equal(
    classifyProcessToken(bound, macosProcessToken(123, { ...fields(900), sess: "98" })),
    "changed",
  );
  assert.equal(
    classifyProcessToken(bound, macosProcessToken(123, { ...fields(900), command: "node /opt/claude --resume RETITLED" })),
    "changed",
    "a rewritten argv/process title is a live process, not an exit",
  );
});

test("a live process with changed identity fields is not ended, stopped or resumed", () => {
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
    const bound = macosProcessToken(123, {
      lstart: "Mon Nov  2 03:25:13 2026",
      ppid: "45",
      pgid: "44",
      sess: "44",
      cpuCentis: 250,
      command: "node /opt/claude --resume x",
    });
    assert.equal(
      bindRuntimeInstance(db, instance.id, "owned", 123, {
        inspect: () => ({ runtime: "claude", token: bound }),
      }),
      true,
    );
    // The same LIVE process re-parents (ppid 45 → 1) and rewrites its title.
    const changed = macosProcessToken(123, {
      lstart: "Mon Nov  2 03:25:13 2026",
      ppid: "1",
      pgid: "44",
      sess: "44",
      cpuCentis: 900,
      command: "node /opt/claude --resume RETITLED",
    });
    const inspectChanged = () => ({ runtime: "claude" as const, token: changed });

    // Refresh must NOT end the row (ending it would allow a resume that
    // double-runs a session whose process is still alive).
    db.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE id = 'owned'").run(
      new Date(Date.now() - 300_000).toISOString(),
    );
    const listed = listRuntimeInstances(db, { inspect: inspectChanged }).find(
      (i) => i.id === instance.id,
    )!;
    assert.equal(listed.state, "stale", "a changed-but-alive process goes stale, never ended");
    assert.equal(listed.can_stop, false);
    assert.equal(listed.can_resume, false, "resume must be refused while the original process lives");
    assert.match(listed.limitation ?? "", /仍在运行但身份字段已变化/);

    // Stop is refused with the changed-but-alive reason, not a reuse claim.
    assert.throws(
      () => stopRuntimeInstance(db, instance.id, { inspect: inspectChanged }),
      /仍在运行但身份字段已变化/,
    );
  } finally {
    cleanup();
  }
});

test("a token naming a different pid is provably replaced, not changed", () => {
  // The row was re-pointed at another live process (the E2E PID-reuse
  // scenario): the stored token embeds the ORIGINAL pid, so a pid
  // mismatch is proof of a different process even when both spawned in
  // the same second with comparable CPU.
  const fields = (pid: number, cpuCentis: number): MacosProcessFields => ({
    lstart: "Mon Nov  2 03:25:13 2026",
    ppid: "45",
    pgid: "44",
    sess: "44",
    cpuCentis,
    command: "node /opt/claude --resume x",
  });
  const stored = macosProcessToken(123, fields(123, 250));
  const rePointed = macosProcessToken(7772, fields(7772, 900));
  assert.equal(classifyProcessToken(stored, rePointed), "replaced");
  const legacyStored = "123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef";
  assert.equal(classifyProcessToken(legacyStored, rePointed), "replaced");
});

test("legacy-format tokens from earlier builds are never judged a replacement they cannot prove", () => {
  // Upgrade-compatibility: rows written by the previous build store the
  // pre-generation token "<pid>:<lstart>:<ppid>:<digest>" — no process
  // group, session or CPU floor. The same LIVE process inspected with the
  // current format carries richer fields; the classifier must not call
  // that "replaced" (it would end the row and allow resuming next to the
  // still-running original).
  const fields = (cpuCentis: number): MacosProcessFields => ({
    lstart: "Mon Nov  2 03:25:13 2026",
    ppid: "45",
    pgid: "44",
    sess: "44",
    cpuCentis,
    command: "node /opt/claude --resume x",
  });
  const legacy = parseLegacyMacosToken("123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef");
  assert.ok(legacy, "the legacy format parses");
  assert.equal(legacy.pid, "123");
  assert.equal(legacy.lstart, "Mon Nov  2 03:25:13 2026");
  assert.equal(legacy.ppid, "45");
  assert.equal(legacy.digest, "0123456789abcdef");

  // Same generation, same descriptors → same: a fresh bind can re-store
  // the current-format token (natural migration). The legacy digest must
  // match the command, so derive it from the current token.
  const currentSame = macosProcessToken(123, fields(900));
  const realDigest = currentSame.split(":").at(-2)!;
  const legacyStored = `123:Mon Nov  2 03:25:13 2026:45:${realDigest}`;
  assert.equal(
    parseLegacyMacosToken(legacyStored)?.digest,
    realDigest,
    "fixture: legacy digest matches the current inspection",
  );
  assert.equal(
    classifyProcessToken(legacyStored, currentSame),
    "same",
    "legacy stored vs current inspection with matching identity is the same process",
  );

  // Legacy vs current with a DIFFERENT creation second is provably a new
  // process; with equal creation but differing descriptors it is UNKNOWN —
  // refuse, never end.
  const currentLater = macosProcessToken(123, { ...fields(900), lstart: "Mon Nov  2 03:25:14 2026" });
  assert.equal(
    classifyProcessToken("123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef", currentLater),
    "replaced",
  );
  const currentRetitled = macosProcessToken(123, { ...fields(900), command: "node /opt/claude --resume RETITLED" });
  assert.equal(
    classifyProcessToken("123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef", currentRetitled),
    "unknown",
    "legacy stored vs changed current descriptors cannot be confirmed — unknown, not replaced",
  );

  // Legacy vs legacy keeps the old semantics: equal → same, different
  // creation second → replaced, otherwise unknown.
  assert.equal(
    classifyProcessToken(
      "123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef",
      "123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef",
    ),
    "same",
  );
  assert.equal(
    classifyProcessToken(
      "123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef",
      "123:Mon Nov  2 03:25:14 2026:45:0123456789abcdef",
    ),
    "replaced",
  );
  assert.equal(
    classifyProcessToken(
      "123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef",
      "123:Mon Nov  2 03:25:13 2026:46:0123456789abcdef",
    ),
    "unknown",
  );

  // Non-macOS tokens (Windows CIM / Linux boot_id) stay pure creation
  // stamps: a mismatch remains a replacement.
  assert.equal(classifyProcessToken("boot-id:12345", "boot-id:12346"), "replaced");
});

test("a live instance with a legacy stored token refuses stop and resume instead of ending", () => {
  const { db, cleanup } = makeDb();
  try {
    const preset = createRuntimeAgent(db, { name: "legacy", runtime: "claude" });
    const instance = createRuntimeInstance(db, preset);
    registerSession(db, {
      id: "owned",
      name: "owned",
      runtime: "claude",
      runtime_pid: 123,
      metadata: { runtime_instance_id: instance.id, agent_id: preset.id },
    });
    // The row stores a token in the OLD format (as an upgraded database
    // would); the live process now reports the richer current format with
    // a mutated descriptor (re-parented).
    db.prepare("UPDATE runtime_instances SET session_id = 'owned', runtime_pid = 123, process_token = ?, state = 'running' WHERE id = ?").run(
      "123:Mon Nov  2 03:25:13 2026:45:0123456789abcdef",
      instance.id,
    );
    const current = macosProcessToken(123, {
      lstart: "Mon Nov  2 03:25:13 2026",
      ppid: "1",
      pgid: "44",
      sess: "44",
      cpuCentis: 900,
      command: "node /opt/claude --resume x",
    });
    const inspect = () => ({ runtime: "claude" as const, token: current });

    const listed = listRuntimeInstances(db, { inspect }).find((i) => i.id === instance.id)!;
    assert.equal(listed.state, "running", "an unconfirmable legacy identity must NOT end the row");
    assert.equal(listed.can_stop, false);
    assert.equal(listed.can_resume, false);
    assert.match(listed.limitation ?? "", /无法验证进程身份/);
    assert.throws(
      () => stopRuntimeInstance(db, instance.id, { inspect }),
      /无法验证进程身份/,
    );
  } finally {
    cleanup();
  }
});

test("macOS ps parsing: a record with any missing identity field is unverifiable", () => {
  const full =
    "Mon Nov  2 03:25:13 2026           45      44      44       0:04.15 node /opt/claude --resume x";
  const parsed = parseMacosPs(full);
  assert.ok(parsed, "a complete record parses");
  assert.equal(parsed.ppid, "45");
  assert.equal(parsed.pgid, "44");
  assert.equal(parsed.sess, "44");
  assert.equal(parsed.cpuCentis, 415); // "0:04.15" = 4.15 s = 415 centiseconds
  assert.equal(parsed.command, "node /opt/claude --resume x");
  // Missing command (empty after fields) or a broken cputime makes the
  // identity unverifiable — the inspector returns null and stop/resume
  // refuse rather than guess.
  assert.equal(parseMacosPs("Mon Nov  2 03:25:13 2026           45      44      44       0:04.15"), null);
  assert.equal(
    parseMacosPs("Mon Nov  2 03:25:13 2026           45      44      44       xx:yy node"),
    null,
  );
});

test("a requested stop completes once the exit is verifiable, without re-terminating", () => {
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
    // First stop sends the signal; the immediate re-inspect loses the race
    // with the exit, so the stop stays requested but unverified.
    const requested = stopRuntimeInstance(db, instance.id, {
      inspect,
      terminate: () => {},
    });
    assert.equal(requested.state, "running");
    assert.ok(requested.stop_requested_at);
    // The process exits on its own afterwards; a later stop must complete
    // the stop instead of refusing with a bare conflict.
    alive = false;
    const finished = stopRuntimeInstance(db, instance.id, {
      inspect,
      terminate: () => assert.fail("must not re-terminate an exited process"),
    });
    assert.equal(finished.state, "ended");
    assert.equal(getSession(db, "owned")?.status, "ended");
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

test("resume snapshots the original preset, uses the original conversation and rejects duplicate resumes", async () => {
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
    const resumed = await resumeRuntimeInstance(db, instance.id, options);
    assert.notEqual(resumed.instance.id, instance.id);
    assert.equal(resumed.instance.resumed_from, instance.id);
    assert.match(command, /--resume.*conversation/);
    assert.match(command, /original/);
    assert.match(command, /retain me/);
    assert.equal(key, "test-secret");
    await assert.rejects(resumeRuntimeInstance(db, instance.id, options), { statusCode: 409 });
    assert.equal(
      JSON.stringify(listRuntimeInstances(db, { inspect: () => null })).includes("test-secret"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("stale and unregistered timed-out resumes retain their conversation reservation", async () => {
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
    const resumed = await resumeRuntimeInstance(db, original.id, {
      inspect,
      launch: () => undefined,
      platform: "win32",
    });
    db.prepare(
      "UPDATE runtime_instances SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(resumed.instance.id);
    listRuntimeInstances(db, { inspect });
    assert.equal(getRuntimeInstance(db, resumed.instance.id, { inspect })?.state, "failed");
    await assert.rejects(
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
    await assert.rejects(
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
