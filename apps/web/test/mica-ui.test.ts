import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentThread, MicaPaneInfo } from "@conflux/shared";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost:3121/",
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.localStorage = dom.window.localStorage;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
if (!dom.window.HTMLElement.prototype.scrollIntoView) {
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
}

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { WorkspaceToolPane } = await import("../src/components/WorkspaceToolPane.tsx");

const { useLiveEvents } = await import("../src/use-live-events.ts");

function withQueryClient(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client: qc }, node);
}

function makePane(paneId: number, overrides: Partial<MicaPaneInfo> = {}): MicaPaneInfo {
  return {
    window_id: 1,
    tab_index: paneId,
    pane_id: paneId,
    pid: null,
    cwd: "C:\\Projects\\my-app",
    title: `pane-${paneId}`,
    is_active: true,
    is_focused: false,
    is_quick_terminal: false,
    prompt_state: "idle",
    last_exit_code: null,
    badge: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: "claude-yuqi",
    project_id: 1,
    name: "Claude · 后端",
    kind: "managed",
    runtime: "claude",
    state: "idle",
    approval_mode: "ask",
    incoming_call_mode: "auto",
    host: "yuqi",
    workdir: "C:\\Projects\\my-app",
    worktree_path: null,
    worktree_branch: "feat/auth",
    base_branch: "main",
    pr_url: null,
    preview_url: null,
    model: "claude-sonnet-4-6",
    instructions: null,
    extra_env: null,
    provider_thread_id: "sess-1",
    active_turn_id: null,
    pid: 1001,
    parent_thread_id: null,
    last_synced_context_id: 0,
    last_seen_at: "2026-11-26T00:00:00Z",
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-26T00:00:00Z",
    live: true,
    supports_steer: true,
    pending_approvals: 0,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  dom.window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Mica external terminal bridge UI", () => {
  it("unbound thread with Mica installed offers open + attach while embedded shell stays primary", async () => {
    const thread = makeThread({ mica_pane_id: null });
    const calls: CapturedCall[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/mica/status")) {
        return new Response(
          JSON.stringify({
            available: true,
            running: true,
            executable: "mica",
            panes: [makePane(7), makePane(8)],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/threads/${thread.id}/mica/open`) && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            pane: makePane(9),
            thread: makeThread({ mica_pane_id: 9 }),
            reused: false,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const view = render(
      withQueryClient(
        React.createElement(WorkspaceToolPane, {
          thread,
          tool: "term",
          layout: "split",
          onSendPromptToAgent: () => {},
        }),
      ),
    );

    await waitFor(() => assert.ok(view.getByTestId("mica-open-btn")));
    const options = view.getByTestId("mica-attach-select").querySelectorAll("option");
    assert.equal(options.length, 3, "placeholder + two attachable panes");
    assert.match(options[1].textContent ?? "", /#7/);
    // Embedded shell stays available as the default surface.
    assert.ok(view.getByTestId("workspace-terminal-input"));
    assert.ok(view.queryByTestId("mica-snapshot-view") === null);

    fireEvent.click(view.getByTestId("mica-open-btn"));
    await waitFor(() => {
      const openCall = calls.find((c) => c.url.endsWith(`/threads/${thread.id}/mica/open`));
      assert.ok(openCall, "open request fired");
      assert.deepEqual(openCall?.body, { mode: "tab" });
    });
    await waitFor(() =>
      assert.match(view.getByTestId("mica-notice-banner").textContent ?? "", /#9/),
    );
  });

  it("bound pane shows capsule + snapshot mode, sends typed commands and snapshot to the agent", async () => {
    const thread = makeThread({ mica_pane_id: 7 });
    const calls: CapturedCall[] = [];
    const agentPrompts: string[] = [];
    const snapshot = {
      pane_id: 7,
      cols: 120,
      rows: 30,
      text: "$ npm test\nall 12 pass",
      truncated: false,
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/mica/status")) {
        return new Response(
          JSON.stringify({
            available: true,
            running: true,
            executable: "mica",
            panes: [makePane(7, { prompt_state: "running" })],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/threads/${thread.id}/mica/read`)) {
        return new Response(JSON.stringify(snapshot), { status: 200 });
      }
      if (url.endsWith(`/threads/${thread.id}/mica/send`) && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith(`/threads/${thread.id}/mica/focus`) && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const view = render(
      withQueryClient(
        React.createElement(WorkspaceToolPane, {
          thread,
          tool: "term",
          layout: "split",
          onSendPromptToAgent: async (prompt: string) => {
            agentPrompts.push(prompt);
          },
        }),
      ),
    );

    await waitFor(() => assert.match(view.getByTestId("mica-pane-capsule").textContent ?? "", /Mica #7/));
    assert.ok(view.getByTestId("mica-focus-btn"));
    assert.ok(view.getByTestId("mica-read-btn"));
    assert.ok(view.getByTestId("mica-send-snapshot-btn"));
    assert.ok(view.getByTestId("mica-unbind-btn"));

    fireEvent.click(view.getByTestId("mica-focus-btn"));
    await waitFor(() =>
      assert.ok(calls.some((c) => c.url.endsWith(`/threads/${thread.id}/mica/focus`))),
    );

    // Refreshing from the embedded view must jump to the snapshot surface.
    fireEvent.click(view.getByTestId("mica-read-btn"));
    await waitFor(() => assert.match(view.getByTestId("mica-snapshot-view").textContent ?? "", /all 12 pass/));

    // Typed commands go to the bound pane literally (Windows paths survive)
    // with a separate Enter keystroke appended server-side.
    fireEvent.change(view.getByTestId("mica-input"), { target: { value: "dir C:\\new" } });
    fireEvent.keyDown(view.getByTestId("mica-input"), { key: "Enter" });
    await waitFor(() => {
      const sendCall = calls.find(
        (c) => c.url.endsWith(`/threads/${thread.id}/mica/send`) && c.method === "POST",
      );
      assert.ok(sendCall, "send request fired");
      assert.deepEqual(sendCall?.body, { text: "dir C:\\new", submit: true, literal: true });
    });

    // One click forwards the current snapshot to the active agent.
    fireEvent.click(view.getByTestId("mica-send-snapshot-btn"));
    await waitFor(() => assert.equal(agentPrompts.length, 1));
    assert.match(agentPrompts[0], /pane #7/);
    assert.match(agentPrompts[0], /all 12 pass/);

    // Unbind keeps the terminal itself alive (DELETE, no process kill).
    fireEvent.click(view.getByTestId("mica-unbind-btn"));
    await waitFor(() => {
      assert.ok(
        calls.some((c) => c.url.endsWith(`/threads/${thread.id}/mica`) && c.method === "DELETE"),
      );
    });
    await waitFor(() =>
      assert.match(view.getByTestId("mica-notice-banner").textContent ?? "", /解除/),
    );
  });

  it("missing Mica degrades to a quiet hint without blocking the embedded shell", async () => {
    const thread = makeThread({ mica_pane_id: null });
    const calls: CapturedCall[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/mica/status")) {
        return new Response(
          JSON.stringify({ available: false, running: false, executable: "mica", panes: [] }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/threads/${thread.id}/terminal/exec`) && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            command: "git status",
            cwd: thread.workdir,
            stdout: "clean",
            stderr: "",
            exit_code: 0,
            duration_ms: 5,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const view = render(
      withQueryClient(
        React.createElement(WorkspaceToolPane, {
          thread,
          tool: "term",
          layout: "split",
          onSendPromptToAgent: () => {},
        }),
      ),
    );

    await waitFor(() => assert.match(view.getByTestId("workspace-terminal-pane").textContent ?? "", /未检测到 Mica/));
    assert.ok(view.queryByTestId("mica-open-btn") === null);
    assert.ok(view.queryByTestId("mica-attach-select") === null);

    // The embedded shell keeps working exactly as before.
    fireEvent.change(view.getByTestId("workspace-terminal-input"), {
      target: { value: "git status" },
    });
    fireEvent.keyDown(view.getByTestId("workspace-terminal-input"), { key: "Enter" });
    await waitFor(() =>
      assert.ok(
        calls.some(
          (c) => c.url.endsWith(`/threads/${thread.id}/terminal/exec`) && c.method === "POST",
        ),
      ),
    );
    await waitFor(() => assert.match(view.getByTestId("workspace-terminal-pane").textContent ?? "", /clean/));
  });
});

it("live Mica exit failures can be dismissed or sent with a fresh snapshot", async () => {
  const thread = makeThread({ mica_pane_id: 7 });
  const prompts: string[] = [];
  let exitCode: number | null = 1;
  let statusReads = 0;
  let snapshotText = "stale cached output";
  const snapshotQueries: URLSearchParams[] = [];

  let source: FakeEventSource | undefined;
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { source = this; }
    close() {}
  }
  const originalEventSource = globalThis.EventSource;
  g.EventSource = FakeEventSource;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/mica/status") {
      statusReads++;
      return Response.json({
        available: true,
        running: true,
        executable: "mica",
        panes: [makePane(7, { last_exit_code: exitCode })],
      });
    }
    if (url.pathname.endsWith("/mica/read")) {
      snapshotQueries.push(url.searchParams);
      return Response.json({ pane_id: 7, cols: 120, rows: 30, text: snapshotText, truncated: false });
    }
    return Response.json({});
  }) as typeof fetch;

  function TerminalWithEvents() {
    useLiveEvents();
    return React.createElement(WorkspaceToolPane, {
      thread,
      tool: "term",
      layout: "split",
      onSendPromptToAgent: (prompt) => { prompts.push(prompt); },
    });
  }
  async function updateExit(next: number | null) {
    const before = statusReads;
    exitCode = next;
    await act(async () => {
      assert.ok(source?.onmessage);
      source.onmessage({
        data: JSON.stringify({
          type: "mica.updated",
          thread_id: thread.id,
          payload: { event: { type: "prompt_state_changed", pane_id: 7, exit_code: next } },
        }),
      });
    });
    await waitFor(() => assert.ok(statusReads > before, "SSE should refresh Mica status"));
  }

  try {
    const view = render(withQueryClient(React.createElement(TerminalWithEvents)));
    const alert = await view.findByTestId("mica-exit-alert");
    assert.match(alert.textContent ?? "", /exit 1/);
    fireEvent.click(view.getByTestId("mica-read-btn"));
    await waitFor(() => assert.match(view.getByTestId("mica-snapshot-view").textContent ?? "", /stale cached output/));
    snapshotText = "$ npm test\ncurrent failure";
    fireEvent.click(view.getByTestId("mica-troubleshoot-btn"));
    await waitFor(() => assert.equal(prompts.length, 1));
    assert.match(prompts[0], /exit 1/);
    assert.match(prompts[0], /current failure/);
    assert.doesNotMatch(prompts[0], /stale cached output/);
    assert.ok(snapshotQueries.length >= 2);
    assert.match(snapshotQueries.at(-1)?.get("scrollback") ?? "", /^(1|true)$/);
    assert.equal(snapshotQueries.at(-1)?.get("lines"), "200");

    fireEvent.click(view.getByRole("button", { name: "关闭退出异常提示" }));
    assert.equal(view.queryByTestId("mica-exit-alert"), null);
    await updateExit(1);
    assert.equal(view.queryByTestId("mica-exit-alert"), null);
    await updateExit(2);
    await waitFor(() => assert.match(view.getByTestId("mica-exit-alert").textContent ?? "", /exit 2/));
    await updateExit(0);
    await waitFor(() => assert.equal(view.queryByTestId("mica-exit-alert"), null));
    await updateExit(1);
    await view.findByTestId("mica-exit-alert");
    await updateExit(null);
    await waitFor(() => assert.equal(view.queryByTestId("mica-exit-alert"), null));
  } finally {
    if (originalEventSource === undefined) delete g.EventSource;
    else g.EventSource = originalEventSource;
  }
});
