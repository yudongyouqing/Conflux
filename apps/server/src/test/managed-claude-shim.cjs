"use strict";

/**
 * Deterministic Claude Code stream-json SDK control-protocol shim for E2E tests.
 * Speaks the exact NDJSON frames observed from `claude -p --input-format stream-json
 * --output-format stream-json --verbose --permission-prompts host`.
 */

const readline = require("node:readline");
const { randomUUID } = require("node:crypto");

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const sessionId = argValue("--resume") || argValue("--session-id") || randomUUID();
const isResume = Boolean(argValue("--resume"));

let reqSeq = 0;
const pendingApprovals = new Map();
let activeSlow = null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function finishTurn(text, opts = {}) {
  if (!opts.skipAssistant && text) {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    });
  }
  emit({
    type: "result",
    subtype: opts.subtype ?? (opts.isError ? "error_during_execution" : "success"),
    is_error: Boolean(opts.isError),
    result: text ?? "",
    session_id: sessionId,
  });
}

function requestToolApproval(toolName, input, onDecision) {
  const requestId = `claude_tool_req_${++reqSeq}`;
  pendingApprovals.set(requestId, onDecision);
  emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === "control_request" && msg.request) {
    const reqId = msg.request_id;
    const subtype = msg.request.subtype;
    if (subtype === "initialize") {
      emit({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        resumed: isResume,
      });
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: {
            pid: process.pid,
            session_id: sessionId,
            current_permission_mode: "default",
          },
        },
      });
      return;
    }

    if (subtype === "interrupt") {
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: { interrupted: true },
        },
      });
      if (activeSlow) {
        clearTimeout(activeSlow.timer);
        activeSlow = null;
        finishTurn("interrupted by host", { subtype: "interrupted", skipAssistant: true });
      }
      return;
    }

    emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: reqId,
        error: `unknown control subtype: ${subtype}`,
      },
    });
    return;
  }

  if (msg.type === "control_response" && msg.response) {
    const reqId = msg.response.request_id;
    const cb = pendingApprovals.get(reqId);
    if (cb) {
      pendingApprovals.delete(reqId);
      cb(msg.response.response || {});
    }
    return;
  }

  if (msg.type === "user" && msg.message) {
    const text = String(msg.message.content ?? "");

    if (text.includes("[CRASH]")) {
      process.exit(1);
      return;
    }

    if (text.includes("[SLOW]")) {
      const timer = setTimeout(() => {
        activeSlow = null;
        finishTurn(`slow-done:${text}`);
      }, 30_000);
      activeSlow = { timer };
      return;
    }

    if (text.includes("[APPROVE_BASH]")) {
      requestToolApproval(
        "Bash",
        { command: "echo approved-bash", description: "Run shell echo", cwd: process.cwd() },
        (resp) => {
          if (resp.behavior === "allow") {
            finishTurn(`bash-allowed:${resp.updatedInput?.command ?? ""}`);
          } else {
            finishTurn(`bash-denied:${resp.message ?? ""}`);
          }
        },
      );
      return;
    }

    if (text.includes("[APPROVE_EDIT]")) {
      requestToolApproval(
        "Edit",
        {
          file_path: "/tmp/demo.ts",
          old_string: "a",
          new_string: "b",
          description: "Update demo file",
        },
        (resp) => {
          if (resp.behavior === "allow") {
            finishTurn(`edit-allowed:${resp.updatedInput?.file_path ?? ""}`);
          } else {
            finishTurn(`edit-denied:${resp.message ?? ""}`);
          }
        },
      );
      return;
    }

    finishTurn(`${isResume ? "resumed" : "echo"}:${text}`);
  }
});

rl.on("close", () => {
  process.exit(0);
});
