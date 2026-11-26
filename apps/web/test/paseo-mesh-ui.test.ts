import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentThread, CliProbeEntry, Graph, Message, Project } from "@conflux/shared";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost:3120/",
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

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { ActivityRail } = await import("../src/components/ActivityRail.tsx");
const { WorkspaceSidebar } = await import("../src/components/WorkspaceSidebar.tsx");
const { NewWorkspaceModal } = await import("../src/components/NewWorkspaceModal.tsx");
const { PaseoToolPane } = await import("../src/components/PaseoToolPane.tsx");
const { LiveMeshGraph } = await import("../src/components/LiveMeshGraph.tsx");

function withQueryClient(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client: qc }, node);
}

const PROBES: CliProbeEntry[] = [
  {
    runtime: "claude",
    label: "Claude Code",
    executable: "claude",
    available: true,
    resolved_path: "/bin/claude",
    version: "2.1.278",
    models: ["claude-sonnet-4-6"],
    supports_steer: true,
  },
  {
    runtime: "codex",
    label: "Codex",
    executable: "codex",
    available: true,
    resolved_path: "/bin/codex",
    version: "0.164.0",
    models: ["gpt-5.3-codex"],
    supports_steer: true,
  },
  {
    runtime: "antigravity",
    label: "Antigravity",
    executable: "agy",
    available: true,
    resolved_path: "/bin/agy",
    version: "1.5.15",
    models: ["gemini-2.5-pro"],
    supports_steer: true,
  },
];

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
    pr_url: "https://github.com/demo/my-app/pull/42",
    preview_url: "http://localhost:5173",
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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.document.documentElement.dataset.theme = "dark";
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Full Paseo + Conflux MCP Mesh Web UI", () => {
  it("ActivityRail shows live call badge and triggers navigation/collapse", () => {
    let selectedScreen = "workspace";
    let toggledSidebar = 0;
    const view = render(
      React.createElement(ActivityRail, {
        screen: "workspace",
        activeCallCount: 2,
        sidebarCollapsed: false,
        onSelectScreen: (s) => {
          selectedScreen = s;
        },
        onOpenHistory: () => {},
        onOpenConnect: () => {},
        onToggleTheme: () => {},
        onToggleSidebar: () => {
          toggledSidebar += 1;
        },
      }),
    );

    assert.equal(view.getByTestId("rail-active-calls-badge").textContent, "2");
    fireEvent.click(view.getByTestId("rail-graph-btn"));
    assert.equal(selectedScreen, "graph");
    fireEvent.click(view.getByTestId("rail-sidebar-toggle-btn"));
    assert.equal(toggledSidebar, 1);
  });

  it("WorkspaceSidebar groups strictly by Host -> Directory -> Session and filters live calls", () => {
    const projects: Project[] = [
      {
        id: 1,
        name: "my-app",
        root_path: "C:\\Projects\\my-app",
        default_branch: "main",
        is_git_repo: true,
        created_at: "2026-11-26T00:00:00Z",
        updated_at: "2026-11-26T00:00:00Z",
      },
    ];
    const localThread = makeThread();
    const remoteThread = makeThread({
      id: "codex-mac",
      project_id: null,
      name: "Codex · mac-mini",
      kind: "external",
      runtime: "codex",
      host: "mac-mini",
      workdir: "/Users/yuqi/dev/ios-client",
      worktree_branch: null,
      pr_url: null,
      preview_url: null,
    });
    const activeCall: Message = {
      id: 11,
      edge_id: 1,
      from_session: localThread.id,
      to_session: remoteThread.id,
      from_name: localThread.name,
      to_name: remoteThread.name,
      question: "核对 auth.ts",
      reply: null,
      status: "pending",
      room_id: null,
      trace_id: "tr_a91f",
      hop_count: 1,
      created_at: "2026-11-26T00:00:00Z",
      replied_at: null,
    };

    let entered = "";
    const view = render(
      React.createElement(WorkspaceSidebar, {
        collapsed: false,
        projects,
        threads: [localThread, remoteThread],
        activeCalls: [activeCall],
        activeThreadId: localThread.id,
        localHostname: "yuqi",
        onSelectThread: (id) => {
          entered = id;
        },
        onOpenNewWorkspace: () => {},
      }),
    );

    assert.ok(view.getByTestId("sidebar-host-yuqi"));
    assert.ok(view.getByTestId("sidebar-host-mac-mini"));
    fireEvent.click(view.getByTestId("sidebar-thread-codex-mac"));
    assert.equal(entered, "codex-mac");
  });

  it("NewWorkspaceModal supports Paseo 3 modes (direct / worktree / checkout PR)", async () => {
    let submittedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/threads") && init?.method === "POST") {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ thread: makeThread({ id: "pr-42-ws" }) }), {
          status: 201,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    let createdId = "";
    const view = render(
      React.createElement(NewWorkspaceModal, {
        open: true,
        onClose: () => {},
        projects: [],
        defaultDir: "C:\\Projects\\my-app",
        cliProbes: PROBES,
        onCreated: (t) => {
          createdId = t.id;
        },
      }),
    );

    fireEvent.click(view.getByTestId("ws-mode-pr"));
    fireEvent.change(view.getByTestId("new-workspace-pr-input"), { target: { value: "42" } });
    fireEvent.click(view.getByTestId("new-agent-submit-btn"));

    await waitFor(() => assert.equal(createdId, "pr-42-ws"));
    assert.equal(submittedBody?.workspace_mode, "pr");
    assert.equal(submittedBody?.pr_number, "42");
    assert.equal(submittedBody?.workdir, "C:\\Projects\\my-app");
  });

  it("PaseoToolPane renders Git/PR with 1-click Send Review to Agent, Embedded Terminal & Files", async () => {
    const thread = makeThread();
    const sentPrompts: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${thread.id}/git/status`)) {
        return new Response(
          JSON.stringify({
            is_git_repo: true,
            branch: "feat/auth",
            base_branch: "main",
            worktree_path: null,
            dirty: true,
            files: [{ path: "src/auth.ts", status: "modified", staged: true, additions: 12, deletions: 2 }],
            gh_available: true,
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/threads/${thread.id}/git/diff`)) {
        return new Response(
          JSON.stringify({ path: null, diff: "+ const leeway = 30;\n", truncated: false }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/threads/${thread.id}/git/pr-detail`)) {
        return new Response(
          JSON.stringify({
            gh_available: true,
            pr: {
              number: 42,
              title: "feat(auth): add leeway",
              state: "OPEN",
              url: "https://github.com/demo/my-app/pull/42",
              head_branch: "feat/auth",
              base_branch: "main",
              is_draft: false,
              checks: [{ name: "ios auth", status: "fail", description: "missing doc" }],
              comments: [
                { id: "c1", author: "@reviewer", path: "src/auth.ts", line: 18, body: "限制上限 120s" },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/threads/${thread.id}/terminal/exec`) && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            command: "npm test",
            cwd: thread.workdir,
            stdout: "12/12 passed",
            stderr: "",
            exit_code: 0,
            duration_ms: 42,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const gitView = render(
      withQueryClient(
        React.createElement(PaseoToolPane, {
          thread,
          tool: "git",
          layout: "split",
          onSendPromptToAgent: (p) => {
            sentPrompts.push(p);
          },
        }),
      ),
    );

    await waitFor(() => assert.ok(gitView.getByTestId("send-review-fix-c1")));
    fireEvent.click(gitView.getByTestId("send-review-fix-c1"));
    assert.equal(sentPrompts.length, 1);
    assert.match(sentPrompts[0], /PR #42.*限制上限 120s/s);
    gitView.unmount();

    const termView = render(
      withQueryClient(
        React.createElement(PaseoToolPane, {
          thread,
          tool: "term",
          layout: "split",
          onSendPromptToAgent: () => {},
        }),
      ),
    );
    const termInp = termView.getByTestId("paseo-terminal-input");
    fireEvent.change(termInp, { target: { value: "npm test" } });
    fireEvent.keyDown(termInp, { key: "Enter" });
    await waitFor(() => assert.match(termView.container.textContent ?? "", /12\/12 passed/));
  });

  it("LiveMeshGraph renders Host -> Dir -> Session nodes, cycles call mode, and opens Audit Drawer", async () => {
    const graph: Graph = {
      nodes: [
        {
          id: "claude-yuqi",
          name: "Claude · 后端",
          kind: "managed",
          runtime: "claude",
          state: "idle",
          host: "yuqi",
          incoming_call_mode: "auto",
          project_id: 1,
          project_name: "my-app",
          workdir: "C:\\Projects\\my-app",
          worktree_branch: "feat/auth",
          pending_approvals: 0,
          context_count: 0,
          room_ids: [],
          live: true,
        },
        {
          id: "codex-mac",
          name: "Codex · mac-mini",
          kind: "external",
          runtime: "codex",
          state: "idle",
          host: "mac-mini",
          incoming_call_mode: "ask",
          external_session_id: "codex_m7710",
          project_id: null,
          project_name: null,
          workdir: "/Users/yuqi/dev/ios-client",
          worktree_branch: null,
          pending_approvals: 0,
          context_count: 0,
          room_ids: [],
          live: true,
        },
      ],
      edges: [],
    };
    const call: Message = {
      id: 77,
      edge_id: 1,
      from_session: "claude-yuqi",
      to_session: "codex-mac",
      from_name: "Claude · 后端",
      to_name: "Codex · mac-mini",
      question: "核对 iOS 客户端 JWT",
      context: "+ leeway = 30",
      reply: null,
      status: "awaiting_approval",
      room_id: null,
      trace_id: "tr_88ab",
      hop_count: 1,
      created_at: "2026-11-26T00:00:00Z",
      replied_at: null,
    };

    const hits: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify({ ok: true, message: { ...call, status: "pending" } }), {
        status: 200,
      });
    }) as typeof fetch;

    const view = render(
      withQueryClient(
        React.createElement(LiveMeshGraph, {
          graph,
          activeCalls: [call],
          allCalls: [call],
          localHostname: "yuqi",
          onEnterWorkspace: () => {},
        }),
      ),
    );

    assert.ok(view.getByTestId("mesh-node-claude-yuqi"));
    assert.ok(view.getByTestId("mesh-node-codex-mac"));

    fireEvent.click(view.getByTestId("node-call-mode-claude-yuqi"));
    await waitFor(() =>
      assert.ok(hits.some((h) => h.includes("POST") && h.includes("/threads/claude-yuqi/call-mode"))),
    );

    fireEvent.click(view.getByTestId("mesh-edge-pill-77"));
    assert.ok(view.getByTestId("audit-approve-btn"));
    fireEvent.click(view.getByTestId("audit-approve-btn"));
    await waitFor(() =>
      assert.ok(hits.some((h) => h.includes("POST") && h.includes("/mesh/calls/77/approve"))),
    );
  });
});
