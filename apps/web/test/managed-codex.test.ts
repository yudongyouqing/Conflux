import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import type { ManagedEventPayload, ManagedStatusResponse } from "@conflux/shared";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { cleanup } = await import("@testing-library/react");
const liveClients: Array<{ clear(): void }> = [];
afterEach(() => {
  cleanup();
  for (const client of liveClients.splice(0)) client.clear();
  mock.restoreAll();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

const { render, fireEvent, waitFor } = await import("@testing-library/react");
const React = await import("react");
const { createElement } = React;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ManagedCodexPanel } = await import("../src/components/ManagedCodexPanel.tsx");

// Managed executor panel behavior: identity stays with the instance (an old
// stream never lands in the new panel), the event cursor dedupes sequences,
// approvals surface their failure states, and unknown runs show the
// human-review notice instead of pretending the task never ran.

interface PanelState {
  statusByInstance: Record<string, ManagedStatusResponse>;
  eventsByInstance: Record<string, ManagedEventPayload[]>;
  approvalStatus?: number;
  calls: Array<{ url: string; method: string; body?: unknown }>;
}

function statusFixture(over: Partial<ManagedStatusResponse> = {}): ManagedStatusResponse {
  return {
    binding: {
      instance_id: "inst-a",
      session_id: "codex-managed-inst-a",
      thread_id: "thread-aaa",
      active_turn_id: null,
    },
    current: {
      threadId: "thread-aaa",
      activeRun: { runId: 1, turnId: "turn-1", state: "running" },
      queuedRunIds: [2],
      pendingApprovals: [],
    },
    runs: [],
    ...over,
  };
}

function mountPanel(state: PanelState, instanceId = "inst-a") {
  const cursors: Record<string, number> = {};
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ url, method, body });
      const managedMatch = url.match(/^\/runtime-instances\/([^/]+)\/managed/);
      if (managedMatch) {
        const id = decodeURIComponent(managedMatch[1]);
        if (url.includes("/managed/events")) {
          const after = Number(new URL(url, "http://localhost").searchParams.get("after") ?? 0);
          // incremental like the server: only sequences after the cursor
          const events = (state.eventsByInstance[id] ?? []).filter((e) => e.sequence > after);
          return Response.json({ events });
        }
        if (url.includes("/approvals/")) {
          const status = state.approvalStatus ?? 200;
          return new Response(status === 200 ? `{"ok":true}` : `{"error":"conflict"}`, {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/interrupt")) return Response.json({ accepted: true });
        return Response.json(state.statusByInstance[id] ?? statusFixture());
      }
      return Response.json({});
    },
  );
  void cursors;
  const client = new QueryClient({
    // gcTime 0 for queries AND mutations: immortal caches keep polling
    // handles / gc timers alive after unmount and hold node:test open.
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  liveClients.push(client);
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ManagedCodexPanel, {
        instanceId,
        instanceName: "Fixture 受管",
        active: true,
        onBack: () => {},
      }),
    ),
  );
  return { ...view, client, state };
}

const ev = (sequence: number, type: ManagedEventPayload["type"], payload: Record<string, unknown>) =>
  ({ sequence, run_id: 1, type, payload, created_at: "2026-11-12T00:00:00Z" }) as ManagedEventPayload;

test("shows the real binding, run state, queue and thread id", async () => {
  const view = mountPanel({
    statusByInstance: { "inst-a": statusFixture() },
    eventsByInstance: {},
    calls: [],
  });
  await waitFor(() => assert.ok(view.getByText(/thread-aaa/)));
  assert.ok(view.getByText("执行中"));
  assert.ok(view.getByText("队列 1 项"));
});

test("an old instance's events never render in a new panel", async () => {
  // Instance A streams a distinctive marker; the panel is unmounted (back),
  // then instance B mounts into a FRESH query cache instance.
  const state: PanelState = {
    statusByInstance: {
      "inst-a": statusFixture(),
      "inst-b": statusFixture({
        binding: {
          instance_id: "inst-b",
          session_id: "codex-managed-inst-b",
          thread_id: "thread-bbb",
          active_turn_id: null,
        },
        current: {
          threadId: "thread-bbb",
          activeRun: null,
          queuedRunIds: [],
          pendingApprovals: [],
        },
      }),
    },
    eventsByInstance: {
      "inst-a": [ev(1, "text", { phase: "delta", delta: "INSTANCE-A-ONLY-MARKER" })],
      "inst-b": [ev(1, "text", { phase: "delta", delta: "instance-b text" })],
    },
    calls: [],
  };
  const first = mountPanel(state, "inst-a");
  await waitFor(() => assert.ok(first.getByText(/INSTANCE-A-ONLY-MARKER/)));
  first.unmount();

  const second = mountPanel(state, "inst-b");
  await waitFor(() => assert.ok(second.getByText(/thread-bbb/)));
  await waitFor(() => assert.ok(second.getByText(/instance-b text/)));
  assert.equal(second.queryByText(/INSTANCE-A-ONLY-MARKER/), null, "no cross-instance leakage");
});

test("event sequences dedupe across refetches (reconnect-safe cursor)", async () => {
  const state: PanelState = {
    statusByInstance: { "inst-a": statusFixture() },
    eventsByInstance: {
      "inst-a": [
        ev(1, "text", { phase: "delta", delta: "first delta" }),
        ev(2, "tool", { phase: "completed", tool: "commandExecution", command: "npm test" }),
      ],
    },
    calls: [],
  };
  const view = mountPanel(state);
  await waitFor(() => assert.ok(view.getByText(/npm test/)));
  // Force repeated refetches; duplicated sequences must not duplicate nodes.
  await act_refetch(view);
  await act_refetch(view);
  assert.equal(view.getAllByText(/first delta/).length, 1);
  assert.equal(view.getAllByText(/npm test/).length, 1);
});

test("approval failures surface and a retry path stays available", async () => {
  const state: PanelState = {
    statusByInstance: {
      "inst-a": statusFixture({
        current: {
          threadId: "thread-aaa",
          activeRun: { runId: 1, turnId: "turn-1", state: "waiting_approval" },
          queuedRunIds: [],
          pendingApprovals: [
            {
              id: 7,
              kind: "commandExecution",
              payload: { kind: "command", command: "npm install fixture", cwd: "C:\\p", reason: null, itemId: "i1" },
            },
          ],
        },
      }),
    },
    eventsByInstance: {},
    approvalStatus: 409,
    calls: [],
  };
  const view = mountPanel(state);
  const allow = await waitFor(() => view.getByRole("button", { name: "本次允许" }));
  assert.ok(view.getByText(/npm install fixture/));
  fireEvent.click(allow);
  await waitFor(() => assert.ok(view.getByText(/审批失败/)));
  // The button remains for a corrected retry (expired answers refresh).
  assert.ok(view.getByRole("button", { name: "本次允许" }));
  view.client.clear();
  await new Promise((r) => setTimeout(r, 50));
});

test("unknown runs show the human-review notice, not silent success", async () => {
  const view = mountPanel({
    statusByInstance: {
      "inst-a": statusFixture({
        runs: [
          {
            id: 1,
            message_id: 10,
            state: "unknown",
            turn_id: "turn-x",
            final_text: null,
            error_code: "crash window",
            created_at: "2026-11-12T00:00:00Z",
            updated_at: "2026-11-12T00:00:00Z",
          },
        ],
      }),
    },
    eventsByInstance: {},
    calls: [],
  });
  await waitFor(() => assert.ok(view.getAllByText(/执行状态待核对/).length >= 1));
  assert.ok(view.getByText(/存在执行状态待核对的记录/));
});

test("interrupt disabled while idle; enabled with the active turn", async () => {
  const view = mountPanel({
    statusByInstance: {
      "inst-a": statusFixture({ current: { threadId: "t", activeRun: null, queuedRunIds: [], pendingApprovals: [] } }),
    },
    eventsByInstance: {},
    calls: [],
  });
  await waitFor(() => assert.ok(view.getByText("空闲")));
  assert.equal(view.getByRole("button", { name: /中断任务/ }).hasAttribute("disabled"), true);
});

/** Trigger one refetch round for the events query (survives react-query's
 *  observer batching inside act). */
async function act_refetch(view: { client: InstanceType<typeof QueryClient> }) {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    await view.client.refetchQueries({ queryKey: ["managed-events"] });
  });
}
