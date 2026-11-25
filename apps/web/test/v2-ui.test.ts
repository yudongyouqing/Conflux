import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AgentThread,
  CliProbeEntry,
  Project,
  Room,
  ThreadApproval,
  ThreadCheckpoint,
  ThreadDetailResponse,
  ThreadEvent,
  WorkflowDefinition,
  WorkflowRun,
} from "@conflux/shared";

// Bootstrap JSDOM before importing @testing-library/react
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
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
const { ApprovalCard } = await import("../src/components/ApprovalCard.tsx");
const { TopBar } = await import("../src/components/TopBar.tsx");
const { ProjectTreeSidebar } = await import("../src/components/ProjectTreeSidebar.tsx");
const { NewAgentModal } = await import("../src/components/NewAgentModal.tsx");
const { AgentWorkbench } = await import("../src/components/AgentWorkbench.tsx");
const { RightInspector } = await import("../src/components/RightInspector.tsx");
const { RoomView } = await import("../src/components/RoomView.tsx");
const { WorkflowView } = await import("../src/components/WorkflowView.tsx");
const { BUILTIN_THEMES, setActiveCustomTheme } = await import("../src/theme.ts");

function withQueryClient(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
    },
  });
  return React.createElement(QueryClientProvider, { client: qc }, node);
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "demo-repo",
    root_path: "/repo/demo",
    default_branch: "main",
    is_git_repo: true,
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: "thr-claude-1",
    project_id: 1,
    name: "Claude 架构师",
    kind: "managed",
    runtime: "claude",
    state: "idle",
    approval_mode: "ask",
    workdir: "/repo/demo/.conflux-worktrees/feat-x",
    worktree_path: "/repo/demo/.conflux-worktrees/feat-x",
    worktree_branch: "conflux/feat-x",
    base_branch: "main",
    model: "claude-sonnet-4-6",
    instructions: null,
    extra_env: null,
    provider_thread_id: "prov-1",
    active_turn_id: null,
    pid: 1234,
    parent_thread_id: null,
    last_synced_context_id: 0,
    last_seen_at: "2026-11-24T00:00:00Z",
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
    live: true,
    supports_steer: true,
    pending_approvals: 0,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<ThreadApproval> = {}): ThreadApproval {
  return {
    id: 42,
    thread_id: "thr-claude-1",
    run_id: 10,
    kind: "toolCall",
    payload: {
      toolName: "Bash",
      command: "npm test",
      options: [
        { optionId: "allow_once", name: "本次允许", kind: "allow_once" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    },
    state: "pending",
    decision: null,
    response_json: null,
    created_at: "2026-11-24T00:00:00Z",
    resolved_at: null,
    thread_name: "Claude 架构师",
    runtime: "claude",
    ...overrides,
  };
}

const PROBES: CliProbeEntry[] = [
  {
    runtime: "antigravity",
    label: "Antigravity",
    executable: "agy",
    available: true,
    resolved_path: "/bin/agy",
    version: "1.5.15",
    models: ["gemini-2.5-pro", "claude-sonnet-4-6"],
    supports_steer: true,
  },
  {
    runtime: "claude",
    label: "Claude Code",
    executable: "claude",
    available: true,
    resolved_path: "/bin/claude",
    version: "2.1.278",
    models: ["claude-sonnet-4-6", "claude-opus-4-6"],
    supports_steer: true,
  },
  {
    runtime: "codex",
    label: "Codex",
    executable: "codex",
    available: true,
    resolved_path: "/bin/codex",
    version: "0.164.0",
    models: ["o4-mini", "gpt-5.3-codex"],
    supports_steer: true,
  },
  {
    runtime: "acp",
    label: "Generic ACP",
    executable: "acp",
    available: false,
    resolved_path: null,
    version: null,
    models: [],
    supports_steer: false,
  },
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.document.documentElement.dataset.theme = "light";
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Conflux v2 Web UI components", () => {
  it("ApprovalCard handles native optionId buttons, userInput answers, and auto_approved badge", async () => {
    const calls: unknown[] = [];
    const ap = makeApproval();
    const view = render(
      React.createElement(ApprovalCard, {
        approval: ap,
        onResolve: (p) => {
          calls.push(p);
        },
      }),
    );

    const allowBtn = view.getByTestId("approval-option-allow_once");
    fireEvent.click(allowBtn);
    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(calls[0], {
      threadId: "thr-claude-1",
      approvalId: 42,
      decision: "accept",
      option_id: "allow_once",
    });
    view.unmount();

    // userInput mode
    const userInputCalls: unknown[] = [];
    const uiAp = makeApproval({
      id: 43,
      kind: "userInput",
      payload: {
        questions: [{ id: "env", question: "部署到哪个环境？", options: [{ label: "staging" }] }],
      },
    });
    const view2 = render(
      React.createElement(ApprovalCard, {
        approval: uiAp,
        onResolve: (p) => {
          userInputCalls.push(p);
        },
      }),
    );
    fireEvent.click(view2.getByText("staging"));
    fireEvent.click(view2.getByText("提交回答"));
    await waitFor(() => assert.equal(userInputCalls.length, 1));
    assert.deepEqual(userInputCalls[0], {
      threadId: "thr-claude-1",
      approvalId: 43,
      decision: "accept",
      answers: { env: "staging" },
    });
    view2.unmount();

    // auto_approved audit badge
    const autoAp = makeApproval({ id: 44, state: "auto_approved" });
    const view3 = render(
      React.createElement(ApprovalCard, { approval: autoAp, onResolve: () => {} }),
    );
    assert.ok(view3.getByTestId("approval-auto-44"));
    assert.match(view3.container.textContent ?? "", /自动批准/);
  });

  it("TopBar renders global approval inbox popover and toggles theme", () => {
    let toggled = 0;
    let jumpedTo = "";
    const view = render(
      React.createElement(TopBar, {
        breadcrumb: "demo-repo / Claude 架构师",
        pendingApprovals: [makeApproval()],
        isDark: false,
        onToggleTheme: () => {
          toggled += 1;
        },
        onOpenNewAgent: () => {},
        onOpenSettings: () => {},
        onOpenMobileSidebar: () => {},
        onResolveApproval: () => {},
        onSelectThread: (tid) => {
          jumpedTo = tid;
        },
      }),
    );

    assert.equal(view.getByTestId("global-approvals-count").textContent, "1");
    fireEvent.click(view.getByTestId("global-approvals-btn"));
    assert.ok(view.getByTestId("global-approvals-popover"));
    fireEvent.click(view.getByText("前往工作台"));
    assert.equal(jumpedTo, "thr-claude-1");

    fireEvent.click(view.getByTestId("theme-toggle-btn"));
    assert.equal(toggled, 1);
  });

  it("ProjectTreeSidebar renders projects, external terminal badge, worktree branch, and approval pulse", () => {
    const project = makeProject();
    const managed = makeThread({ pending_approvals: 2 });
    const external = makeThread({
      id: "ext-codex-1",
      name: "本地 Codex 终端",
      kind: "external",
      runtime: "codex",
      worktree_branch: null,
      pending_approvals: 0,
    });
    const room: Room = {
      id: 9,
      project_id: null,
      name: "跨项目联调",
      description: null,
      members: ["thr-claude-1"],
      created_at: "2026-11-24T00:00:00Z",
      updated_at: "2026-11-24T00:00:00Z",
    };

    let selected: unknown = null;
    const view = render(
      React.createElement(ProjectTreeSidebar, {
        projects: [project],
        threads: [managed, external],
        rooms: [room],
        workflows: [],
        activeView: { kind: "thread", threadId: managed.id },
        mobileOpen: false,
        onCloseMobile: () => {},
        onSelectView: (v) => {
          selected = v;
        },
        onAddProjectClick: () => {},
        onNewAgentForProject: () => {},
        onNewRoomClick: () => {},
      }),
    );

    assert.ok(view.getByTestId("sidebar-project-1"));
    assert.equal(view.getByTestId("sidebar-approval-badge-thr-claude-1").textContent, "2");
    assert.ok(view.getByTestId("external-badge-ext-codex-1"));
    assert.match(view.container.textContent ?? "", /conflux\/feat-x/);

    fireEvent.click(view.getByTestId("sidebar-room-9"));
    assert.deepEqual(selected, { kind: "room", roomId: 9 });
  });

  it("NewAgentModal shows probed CLIs and submits POST /threads", async () => {
    const createdThread = makeThread({ id: "thr-new-1", name: "新编码助手" });
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/threads") && init?.method === "POST") {
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ thread: createdThread }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    let createdId = "";
    const view = render(
      React.createElement(NewAgentModal, {
        open: true,
        onClose: () => {},
        projects: [makeProject()],
        defaultProjectId: 1,
        cliProbes: PROBES,
        templates: [],
        onCreated: (t) => {
          createdId = t.id;
        },
      }),
    );

    fireEvent.click(view.getByTestId("engine-card-claude"));
    fireEvent.change(view.getByTestId("new-agent-name-input"), { target: { value: "新编码助手" } });
    fireEvent.click(view.getByTestId("new-agent-worktree-checkbox"));
    fireEvent.click(view.getByTestId("new-agent-submit-btn"));

    await waitFor(() => assert.equal(createdId, "thr-new-1"));
    assert.equal(capturedBody?.runtime, "claude");
    assert.equal(capturedBody?.use_worktree, true);
    assert.equal(capturedBody?.project_id, 1);
  });

  it("AgentWorkbench renders inline tool diff, checkpoint rollback, approval card, and @ file search", async () => {
    const thread = makeThread({ state: "waiting_approval" });
    const cp: ThreadCheckpoint = {
      id: 7,
      thread_id: thread.id,
      run_id: 10,
      ref_name: "refs/conflux/checkpoints/thr-claude-1/10",
      tree_sha: "abc1234567",
      commit_sha: "def7654321",
      summary: "Run #10",
      created_at: "2026-11-24T00:00:00Z",
    };
    const detail: ThreadDetailResponse = {
      thread,
      runs: [],
      pending_approvals: [makeApproval()],
      checkpoints: [cp],
      queued_run_ids: [],
    };
    const events: ThreadEvent[] = [
      {
        seq: 1,
        thread_id: thread.id,
        run_id: 10,
        type: "user",
        payload: { text: "修改 hello.ts" },
        created_at: "2026-11-24T00:00:01Z",
      },
      {
        seq: 2,
        thread_id: thread.id,
        run_id: 10,
        type: "tool",
        payload: {
          title: "Edit",
          status: "completed",
          diff: { path: "src/hello.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        },
        created_at: "2026-11-24T00:00:02Z",
      },
    ];

    let rolledBackUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${thread.id}`)) {
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      if (url.includes(`/threads/${thread.id}/events`)) {
        return new Response(JSON.stringify({ events }), { status: 200 });
      }
      if (url.includes(`/threads/${thread.id}/files`)) {
        return new Response(
          JSON.stringify({ files: [{ path: "src/hello.ts", name: "hello.ts" }] }),
          { status: 200 },
        );
      }
      if (url.includes(`/checkpoints/7/rollback`) && init?.method === "POST") {
        rolledBackUrl = url;
        return new Response(JSON.stringify({ ok: true, checkpoint_id: 7 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const view = render(
      withQueryClient(
        React.createElement(AgentWorkbench, {
          threadId: thread.id,
          cliProbes: PROBES,
          allThreads: [thread],
          onResolveApproval: () => {},
          onSelectThread: () => {},
          forkModalOpen: false,
          onSetForkModalOpen: () => {},
        }),
      ),
    );

    await waitFor(() => assert.ok(view.getByTestId("inline-tool-diff")));
    assert.match(view.getByTestId("inline-tool-diff").textContent ?? "", /const a = 2;/);
    assert.ok(view.getByTestId("approval-card-42"));

    // Checkpoint rollback button
    fireEvent.click(view.getByTestId("checkpoint-rollback-7"));
    await waitFor(() => assert.match(rolledBackUrl, /checkpoints\/7\/rollback/));

    // @ project file autocomplete
    const composer = view.getByTestId("workbench-composer-input");
    fireEvent.change(composer, { target: { value: "请检查 @hel" } });
    await waitFor(() => assert.ok(view.getByTestId("at-file-popover")));
    fireEvent.click(view.getByTestId("at-file-option-0"));
    assert.equal((composer as HTMLTextAreaElement).value, "请检查 @src/hello.ts ");
  });

  it("RightInspector shows live Git diff and surfaces merge conflicts cleanly", async () => {
    const thread = makeThread();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${thread.id}/git/status`)) {
        return new Response(
          JSON.stringify({
            is_git_repo: true,
            branch: "conflux/feat-x",
            base_branch: "main",
            worktree_path: thread.worktree_path,
            dirty: true,
            files: [{ path: "src/app.ts", status: "modified", staged: false, additions: 3, deletions: 1 }],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/threads/${thread.id}/git/diff`)) {
        return new Response(
          JSON.stringify({
            path: null,
            diff: "diff --git a/src/app.ts b/src/app.ts\n-oldLine()\n+newLine()",
            truncated: false,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/threads/${thread.id}/git/merge`) && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: false,
            merged_branch: "conflux/feat-x",
            target_branch: "main",
            conflicts: ["src/app.ts"],
            message: "合并存在冲突，已自动 abort 恢复主分支干净状态",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/threads/${thread.id}/git/pr`) && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            branch: "conflux/feat-x",
            base_branch: "main",
            pr_url: "https://github.com/demo/repo/pull/88",
            existing: false,
            message: "已推送分支并创建 PR",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/context")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const view = render(
      withQueryClient(
        React.createElement(RightInspector, {
          thread,
          checkpoints: [],
          allThreads: [thread],
          onRollbackCheckpoint: async () => {},
          onOpenForkModal: () => {},
          onSelectThread: () => {},
        }),
      ),
    );

    await waitFor(() => assert.ok(view.getByTestId("git-diff-viewer")));
    assert.match(view.getByTestId("git-diff-viewer").textContent ?? "", /\+newLine\(\)/);

    fireEvent.click(view.getByTestId("merge-worktree-btn"));
    await waitFor(() => assert.ok(view.getByTestId("merge-result-banner")));
    assert.match(view.getByTestId("merge-result-banner").textContent ?? "", /src\/app\.ts/);

    // Lightweight Paseo-style PR creation flow
    fireEvent.click(view.getByTestId("toggle-pr-form-btn"));
    fireEvent.click(view.getByTestId("submit-create-pr-btn"));
    await waitFor(() => assert.ok(view.getByTestId("inspector-pr-link")));
    assert.equal(
      view.getByTestId("inspector-pr-link").getAttribute("href"),
      "https://github.com/demo/repo/pull/88",
    );
  });

  it("RoomView displays inline pending approvals and WorkflowView handles human_gate decisions", async () => {
    const thread = makeThread();
    const roomDetail = {
      room: {
        id: 5,
        project_id: 1,
        name: "架构室",
        description: null,
        members: [thread.id],
        created_at: "2026-11-24T00:00:00Z",
        updated_at: "2026-11-24T00:00:00Z",
      },
      tasks: [
        {
          id: 1,
          room_id: 5,
          initiator_thread_id: "web-console",
          executor_thread_id: thread.id,
          prompt: "评审 API",
          status: "running",
          summary: null,
          message_id: 11,
          created_at: "2026-11-24T00:00:00Z",
          updated_at: "2026-11-24T00:00:00Z",
        },
      ],
      messages: [],
      pending_approvals: [makeApproval({ room_id: 5 })],
    };

    const wf: WorkflowDefinition = {
      id: 3,
      name: "审阅流水线",
      description: null,
      project_id: 1,
      room_id: null,
      steps: [
        {
          key: "gate",
          title: "人工确认",
          kind: "human_gate",
          depends_on: [],
          target_thread_id: null,
          prompt_template: "确认发布",
        },
      ],
      created_at: "2026-11-24T00:00:00Z",
      updated_at: "2026-11-24T00:00:00Z",
    };
    const wfRun: WorkflowRun = {
      id: 99,
      workflow_id: 3,
      project_id: 1,
      room_id: null,
      status: "waiting_human",
      input: "发布 v2",
      initiated_by: "web-console",
      created_at: "2026-11-24T00:00:00Z",
      updated_at: "2026-11-24T00:00:00Z",
      completed_at: null,
      steps: [
        {
          id: 501,
          run_id: 99,
          step_key: "gate",
          title: "人工确认",
          kind: "human_gate",
          depends_on: [],
          target_thread_id: null,
          prompt_template: "确认发布",
          include_handoff: false,
          status: "waiting_human",
          message_id: null,
          output: null,
          error: null,
          started_at: null,
          completed_at: null,
        },
      ],
    };

    let approvedStepId = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/rooms/5")) return new Response(JSON.stringify(roomDetail), { status: 200 });
      if (url.includes("/workflow-runs")) {
        return new Response(JSON.stringify({ runs: [wfRun] }), { status: 200 });
      }
      if (url.endsWith("/workflow-steps/501/approve") && init?.method === "POST") {
        approvedStepId = 501;
        return new Response(JSON.stringify({ run: { ...wfRun, status: "completed" } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const roomView = render(
      withQueryClient(
        React.createElement(RoomView, {
          roomId: 5,
          allThreads: [thread],
          onSelectThread: () => {},
          onResolveApproval: () => {},
        }),
      ),
    );
    await waitFor(() => assert.ok(roomView.getByTestId("room-pending-approvals")));
    roomView.unmount();

    const wfView = render(
      withQueryClient(
        React.createElement(WorkflowView, {
          projectId: 1,
          workflows: [wf],
          allThreads: [thread],
          onSelectThread: () => {},
        }),
      ),
    );
    await waitFor(() => assert.ok(wfView.getByTestId("workflow-gate-approve-501")));
    fireEvent.click(wfView.getByTestId("workflow-gate-approve-501"));
    await waitFor(() => assert.equal(approvedStepId, 501));
  });

  it("Theme switcher syncs data-theme and Electron setNativeTheme bridge", () => {
    const nativeCalls: string[] = [];
    (globalThis as { confluxDesktop?: { setNativeTheme: (m: string) => void } }).confluxDesktop = {
      setNativeTheme: (m: string) => nativeCalls.push(m),
    };

    setActiveCustomTheme(BUILTIN_THEMES[5].name, dom.window.localStorage, dom.window.document.documentElement);
    assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
    assert.equal(nativeCalls.at(-1), "dark");

    setActiveCustomTheme(null, dom.window.localStorage, dom.window.document.documentElement);
    assert.equal(dom.window.document.documentElement.dataset.theme, "light");
    assert.equal(nativeCalls.at(-1), "light");

    delete (globalThis as { confluxDesktop?: unknown }).confluxDesktop;
  });
});
