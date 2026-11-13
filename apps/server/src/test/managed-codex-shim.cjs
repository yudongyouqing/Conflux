// Controllable stand-in for the Codex app-server stdio protocol. Speaks the
// JSONL JSON-RPC subset Conflux's managed executor uses (initialize, thread,
// turn, approvals) with fully synthetic payloads — it never calls a real
// model. Behavior markers ride inside the turn input text:
//
//   "@approval"  pause mid-turn with a server approval request until answered
//   "@burst"     respond + ALL notifications in ONE stdout write (race repro:
//                the response resolves as a microtask while the same chunk's
//                notifications dispatch synchronously first)
//   "@retrycomplete" replay turn/completed at +300ms/+1s/+2.2s — retry repro
//                for completions whose reply write-back failed and rolled back
//   "@crash"     exit(3) after acknowledging turn/start
//   "@fail"      complete the turn with status "failed"
//   "@hold"      stay inProgress until the client sends test/release
//   "@noack"     receive turn/start and never answer it (crash window)
//   "@silent"    finish and record history WITHOUT emitting turn/completed
//   "@slow"      delay the final turn/completed by 400ms
//   "@invalid"   emit one malformed JSON line before completing the turn
//
// Completed turns are appended to SHIM_HISTORY as durable rollout history;
// thread/resume and thread/read serve it back, so a restarted executor can
// reconcile what the previous process actually finished. Every received
// frame is appended to SHIM_LOG (one JSON per line) for send-count asserts.
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const readline = require("node:readline");

const logFile = process.env.SHIM_LOG;
const historyFile = process.env.SHIM_HISTORY;
const logFrame = (frame) => {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir: "in", frame }) + "\n");
};
const historyTurns = () => {
  if (!historyFile || !existsSync(historyFile)) return [];
  return readFileSync(historyFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const recordHistory = (turnId, status, error = null, text = "shim final answer") => {
  if (!historyFile) return;
  appendFileSync(historyFile, JSON.stringify({ turnId, status, error, text }) + "\n");
};

const send = (frame) => {
  process.stdout.write(JSON.stringify(frame) + "\n");
};
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const THREAD_ID = "shim-thread-0001";
const mkThread = () => ({
  id: THREAD_ID,
  sessionId: "shim-session-0001",
  forkedFromId: null,
  parentThreadId: null,
  preview: "shim thread",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  model: "shim-model",
  reasoningEffort: "medium",
  createdAt: 1762896000,
  updatedAt: 1762896000,
  recencyAt: 1762896000,
  status: { type: "idle" },
  path: null,
  cwd: process.env.SHIM_CWD ?? "C:\\tmp\\shim-fixture",
  cliVersion: "0.164.0-shim",
  originator: "conflux",
  source: { custom: "conflux" },
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  // Durable rollout history: turns this THREAD completed in any shim process.
  turns: historyTurns().map((h) => ({
    id: h.turnId,
    rootTurnId: null,
    items: [agentMessageItem(h.text ?? "shim final answer")],
    itemsView: "notLoaded",
    status: h.status,
    error: h.error,
    startedAt: 1762896001,
    completedAt: 1762896003,
    durationMs: 2000,
  })),
});
const mkTurn = (id, status, error = null) => ({
  id,
  rootTurnId: null,
  items: [],
  itemsView: "notLoaded",
  status,
  error,
  startedAt: 1762896001,
  completedAt: status === "inProgress" ? null : 1762896003,
  durationMs: status === "inProgress" ? null : 2000,
});
const turnError = (message) => ({
  message,
  codexErrorInfo: null,
  additionalDetails: null,
  misalignment: null,
});
const agentMessageItem = (text) => ({
  type: "agentMessage",
  id: "shim-item-msg",
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});

async function runTurn(id, params) {
  const text = JSON.stringify(params?.input ?? []);
  const turnId = `shim-turn-${id}`;
  if (text.includes("@noack")) {
    // Crash window: the turn/start was received (handle() already logged
    // the frame) but never acknowledged — hold the request open forever.
    return;
  }
  if (text.includes("@burst")) {
    // Single stdout write: response + full lifecycle arrive in one chunk.
    // The client's frame loop resolves the response as a microtask while
    // processing the notifications synchronously FIRST — the submit-window
    // buffering path must survive exactly this ordering.
    recordHistory(turnId, "completed");
    const frame = (obj) => JSON.stringify(obj);
    process.stdout.write(
      [
        frame({ jsonrpc: "2.0", id, result: { turn: mkTurn(turnId, "inProgress") } }),
        frame({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD_ID, turn: mkTurn(turnId, "inProgress") } }),
        frame({ jsonrpc: "2.0", method: "item/started", params: { item: agentMessageItem(""), threadId: THREAD_ID, turnId, startedAtMs: Date.now() } }),
        frame({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId, itemId: "shim-item-msg", delta: "burst delta" } }),
        frame({ jsonrpc: "2.0", method: "item/completed", params: { item: agentMessageItem("shim final answer"), threadId: THREAD_ID, turnId, completedAtMs: Date.now() } }),
        frame({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD_ID, turn: mkTurn(turnId, "completed") } }),
        "",
      ].join("\n"),
    );
    return;
  }
  respond(id, { turn: mkTurn(turnId, "inProgress") });
  notify("turn/started", { threadId: THREAD_ID, turn: mkTurn(turnId, "inProgress") });

  if (text.includes("@crash")) {
    // acknowledge, then die like a broken child
    setTimeout(() => process.exit(3), 20);
    return;
  }
  if (text.includes("@invalid")) {
    process.stdout.write('{"jsonrpc": "2.0", "id": this-is-not-json\n');
  }

  notify("item/started", {
    item: agentMessageItem(""),
    threadId: THREAD_ID,
    turnId,
    startedAtMs: Date.now(),
  });
  notify("item/agentMessage/delta", {
    threadId: THREAD_ID,
    turnId,
    itemId: "shim-item-msg",
    delta: "shim is working",
  });

  if (text.includes("@approval")) {
    notify("item/started", {
      item: {
        type: "commandExecution",
        id: "shim-item-cmd",
        pluginId: null,
        scriptPath: null,
        command: "node shim-tool.cjs run",
        cwd: process.env.SHIM_CWD ?? "C:\\tmp\\shim-fixture",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
      threadId: THREAD_ID,
      turnId,
      startedAtMs: Date.now(),
    });
    const decision = await new Promise((resolve) => {
      pendingApproval = resolve;
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          threadId: THREAD_ID,
          turnId,
          itemId: "shim-item-cmd",
          startedAtMs: Date.now(),
          approvalId: null,
          environmentId: null,
          reason: "shim approval fixture",
          networkApprovalContext: null,
          command: "node shim-tool.cjs run",
          cwd: process.env.SHIM_CWD ?? "C:\\tmp\\shim-fixture",
          commandActions: [],
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
      });
    });
    pendingApproval = null;
    notify("item/completed", {
      item: {
        type: "commandExecution",
        id: "shim-item-cmd",
        pluginId: null,
        scriptPath: null,
        command: "node shim-tool.cjs run",
        cwd: process.env.SHIM_CWD ?? "C:\\tmp\\shim-fixture",
        processId: null,
        source: "agent",
        status: decision?.decision === "decline" ? "declined" : "completed",
        commandActions: [],
        aggregatedOutput: "shim command output",
        exitCode: decision?.decision === "decline" ? 1 : 0,
        durationMs: 50,
      },
      threadId: THREAD_ID,
      turnId,
      completedAtMs: Date.now(),
    });
  }

  if (text.includes("@slow")) await new Promise((r) => setTimeout(r, 400));
  if (text.includes("@hold")) {
    await new Promise((resolve) => {
      heldTurn = { resolve };
    });
  }

  notify("item/completed", {
    item: agentMessageItem("shim final answer"),
    threadId: THREAD_ID,
    turnId,
    completedAtMs: Date.now(),
  });
  if (text.includes("@fail")) {
    recordHistory(turnId, "failed", turnError("shim model failure fixture"));
    notify("turn/completed", {
      threadId: THREAD_ID,
      turn: mkTurn(turnId, "failed", turnError("shim model failure fixture")),
    });
    return;
  }
  // The rollout history is the durable record — @silent completes the turn
  // WITHOUT notifying, simulating "finished but the client died before the
  // notification was processed".
  recordHistory(turnId, "completed");
  if (text.includes("@silent")) return;
  notify("turn/completed", { threadId: THREAD_ID, turn: mkTurn(turnId, "completed") });
  if (text.includes("@retrycomplete")) {
    // Delayed replays — the retries that must land after earlier
    // completions failed their reply write-back and rolled back.
    for (const delay of [300, 1000, 2200]) {
      setTimeout(
        () => notify("turn/completed", { threadId: THREAD_ID, turn: mkTurn(turnId, "completed") }),
        delay,
      );
    }
  }
}

let pendingApproval = null;
let heldTurn = null; // { resolve } — released by test/release

// SHIM_LINGER=1 (POSIX): survive the first SIGTERM and exit 1500ms later —
// the delayed-termination shape concurrent stop/resume must not turn into
// two live writers. Opt-in via env so ordinary kills stay immediate.
if (process.env.SHIM_LINGER === "1" && process.platform !== "win32") {
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), 1500);
  });
}

async function handle(frame) {
  logFrame(frame);
  const { id, method, params } = frame;
  if (method === "initialize") {
    respond(id, {
      userAgent: "codex_shim/0.164.0-fixture",
      codexHome: process.env.SHIM_CODEX_HOME ?? "C:\\tmp\\shim-codex-home",
      platformFamily: process.platform === "win32" ? "windows" : "unix",
      platformOs: process.platform === "win32" ? "windows" : process.platform,
    });
  } else if (method === "test/release") {
    respond(id, { released: true });
    if (heldTurn) {
      const release = heldTurn;
      heldTurn = null;
      release.resolve();
    }
  } else if (method === "thread/start") {
    respond(id, {
      thread: mkThread(),
      model: "shim-model",
      modelProvider: "openai",
      serviceTier: null,
      disabledPluginIds: [],
      cwd: process.env.SHIM_CWD ?? "C:\\tmp\\shim-fixture",
      instructionSources: [],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      reasoningEffort: "medium",
    });
    notify("thread/started", { thread: { id: THREAD_ID } });
  } else if (method === "thread/resume" || method === "thread/read") {
    respond(id, {
      thread: mkThread(),
      model: "shim-model",
      modelProvider: "openai",
      serviceTier: null,
      disabledPluginIds: [],
      cwd: process.env.SHIM_CWD ?? "C:\\tmp\\shim-fixture",
      instructionSources: [],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      reasoningEffort: "medium",
    });
  } else if (method === "turn/start") {
    await runTurn(id, params);
  } else if (method === "turn/interrupt") {
    const interruptedId = params?.turnId ?? "shim-turn-?";
    recordHistory(interruptedId, "interrupted", turnError("Turn interrupted"));
    respond(id, { turn: mkTurn(interruptedId, "interrupted") });
    notify("turn/completed", {
      threadId: params?.threadId ?? THREAD_ID,
      turn: mkTurn(interruptedId, "interrupted", turnError("Turn interrupted")),
    });
  } else if (method === "error/unknown-method") {
    fail(id, -32601, "method not found: error/unknown-method");
  } else if (method === "hang/forever") {
    // acknowledged in the log, never answered — for crash-window tests
  } else if (id !== undefined && method) {
    // Server request responses arrive as bare {id, result}; only requests
    // with a method land here. Answer unknown client requests politely.
    fail(id, -32601, `shim does not implement ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  // Approval responses are bare {id, result}; route them to the waiter.
  if (!frame.method && pendingApproval && frame.id === 9001) {
    logFrame(frame);
    pendingApproval(frame.result ?? frame);
    return;
  }
  handle(frame).catch(() => {});
});
rl.on("close", () => {
  // stdin closed — a well-behaved app-server exits; crash tests exit earlier.
  process.exit(0);
});
