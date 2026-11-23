"use strict";

/**
 * Deterministic ACP (Agent Client Protocol) JSON-RPC 2.0 test double for
 * Antigravity (`agy acp`) and generic ACP managed executor tests.
 */

const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionCounter = 0;
let activePrompt = null; // { id, sessionId, text, timer }
let pendingPermission = null; // { reqId, resolve }
let nextServerReqId = 1000;
let lastSessionNewParams = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendUpdate(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Response to our server-initiated session/request_permission
  if (msg.id !== undefined && msg.method === undefined && pendingPermission && msg.id === pendingPermission.reqId) {
    const p = pendingPermission;
    pendingPermission = null;
    p.resolve(msg.result);
    return;
  }

  if (msg.method === "initialize") {
    sendResult(msg.id, {
      protocolVersion: 1,
      agentInfo: { name: "agy-shim", version: "1.5.14" },
      agentCapabilities: {
        loadSession: true,
        _meta: {
          antigravity: {
            systemPrompt: { append: true },
          },
        },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    lastSessionNewParams = msg.params;
    const sessionId = `acp-sess-${++sessionCounter}`;
    sendResult(msg.id, { sessionId });
    return;
  }

  if (msg.method === "session/load") {
    sendResult(msg.id, { sessionId: msg.params.sessionId });
    return;
  }

  if (msg.method === "session/cancel") {
    if (activePrompt) {
      const p = activePrompt;
      activePrompt = null;
      if (p.timer) clearTimeout(p.timer);
      sendResult(p.id, { stopReason: "cancelled" });
    }
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    const text = (msg.params.prompt || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Concurrent prompt while a turn is already running => agy >= 1.5.0 steer
    if (activePrompt) {
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `steered:${text}` },
      });
      sendResult(msg.id, { stopReason: "end_turn" });
      if (activePrompt.timer) clearTimeout(activePrompt.timer);
      const orig = activePrompt;
      activePrompt = null;
      sendResult(orig.id, { stopReason: "end_turn" });
      return;
    }

    if (text === "inspect-session-new") {
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(lastSessionNewParams) },
      });
      sendResult(msg.id, { stopReason: "end_turn" });
      return;
    }

    if (text === "stream-chunks") {
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Alpha " },
      });
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Beta " },
      });
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Gamma." },
      });
      sendResult(msg.id, { stopReason: "end_turn" });
      return;
    }

    if (text.startsWith("approve:")) {
      const reqId = ++nextServerReqId;
      sendUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Run tests",
        kind: "execute",
      });
      pendingPermission = {
        reqId,
        resolve(res) {
          const outcome = res && res.outcome ? res.outcome : { outcome: "cancelled" };
          sendUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `perm:${outcome.outcome}:${outcome.optionId || ""}`,
            },
          });
          sendResult(msg.id, { stopReason: "end_turn" });
        },
      };
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tc-1", title: "Run tests", kind: "execute" },
          options: [
            { optionId: "opt_allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "opt_reject_once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }

    if (text.startsWith("slow:")) {
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working..." },
      });
      const timer = setTimeout(() => {
        if (activePrompt && activePrompt.id === msg.id) {
          activePrompt = null;
          sendUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done-slow" },
          });
          sendResult(msg.id, { stopReason: "end_turn" });
        }
      }, 3000);
      activePrompt = { id: msg.id, sessionId, text, timer };
      return;
    }

    sendUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `acp-echo:${text}` },
    });
    sendResult(msg.id, { stopReason: "end_turn" });
  }
});
