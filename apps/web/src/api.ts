import {
  WEB_CONSOLE_ID,
  type AgentTemplate,
  type AgentThread,
  type ApprovalDecision,
  type ApprovalMode,
  type CliProbeEntry,
  type ContextEntry,
  type ContextKind,
  type ForkHandoffResult,
  type GitCommitResult,
  type GitCreatePrResult,
  type GitDiffResponse,
  type GitMergeResult,
  type GitPushResult,
  type GitStatusResponse,
  type Graph,
  type HandoffResult,
  type IncomingCallMode,
  type ManagedDeliveryMode,
  type Message,
  type MicaBadgeState,
  type MicaPaneInfo,
  type MicaReadResult,
  type MicaStatusResponse,
  type PrDetailResponse,
  type PrMergeResult,
  type Project,
  type ProjectFileMatch,
  type Room,
  type RoomTask,
  type RuntimeId,
  type RuntimeSettings,
  type SystemNetworkInfo,
  type ThreadApproval,
  type ThreadDetailResponse,
  type ThreadEvent,
  type ThreadRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStepDefinition,
  type WorkspaceCreateMode,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
  type WorkspaceTerminalRunResult,
  type WorkspaceTreeResponse,
} from "@conflux/shared";

const BASE = (import.meta.env as { VITE_API_BASE?: string } | undefined)?.VITE_API_BASE || "";

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "X-Session-Id": WEB_CONSOLE_ID,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(apiUrl(path), { ...init, headers });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const msg =
      (payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : null) ||
      (payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : null) ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload as T;
}

export const api = {
  // Workspace tree, network & system
  getWorkspaceTree: () => request<WorkspaceTreeResponse>("/workspace/tree"),
  getGraph: () => request<Graph>("/graph"),
  getNetworkInfo: () => request<SystemNetworkInfo>("/system/network"),
  probeRuntimes: (refresh = false) =>
    request<{ runtimes: CliProbeEntry[] }>(`/runtimes/probe${refresh ? "?refresh=1" : ""}`),
  getSettings: () => request<{ settings: RuntimeSettings }>("/settings"),
  saveSettings: (patch: Partial<RuntimeSettings>) =>
    request<{ settings: RuntimeSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // MCP Mesh Calls & Per-node Incoming Policy
  listMeshCalls: (status: "active" | "history" | "all" = "all", limit = 100) =>
    request<{ calls: Message[] }>(`/mesh/calls?status=${status}&limit=${limit}`),
  createMeshCall: (body: {
    from_thread?: string;
    to_thread: string;
    question: string;
    context?: string | null;
  }) =>
    request<{ message: Message; delivered: boolean; delivery_method: string }>("/mesh/calls", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  approveMeshCall: (id: number) =>
    request<{ message: Message; delivered: boolean; delivery_method: string }>(
      `/mesh/calls/${id}/approve`,
      { method: "POST" },
    ),
  hangupMeshCall: (id: number, reason?: string) =>
    request<{ message: Message }>(`/mesh/calls/${id}/hangup`, {
      method: "POST",
      body: JSON.stringify({ ...(reason ? { reason } : {}) }),
    }),
  setIncomingCallMode: (threadId: string, incoming_call_mode: IncomingCallMode) =>
    request<{ thread: AgentThread }>(`/threads/${threadId}/call-mode`, {
      method: "POST",
      body: JSON.stringify({ incoming_call_mode }),
    }),

  // Projects
  listProjects: () => request<{ projects: Project[] }>("/projects"),
  createProject: (body: { root_path: string; name?: string }) =>
    request<{ project: Project }>("/projects", { method: "POST", body: JSON.stringify(body) }),
  deleteProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
  searchProjectFiles: (projectId: number, q: string) =>
    request<{ files: ProjectFileMatch[] }>(
      `/projects/${projectId}/files?q=${encodeURIComponent(q)}&limit=25`,
    ),

  // Templates (legacy compatibility)
  listTemplates: () => request<{ templates: AgentTemplate[] }>("/templates"),

  // Agent Threads (Workspaces)
  createThread: (body: {
    project_id?: number | null;
    workdir?: string;
    name?: string;
    runtime: RuntimeId;
    model?: string | null;
    instructions?: string | null;
    approval_mode?: ApprovalMode;
    use_worktree?: boolean;
    workspace_mode?: WorkspaceCreateMode;
    branch_name?: string | null;
    pr_number?: number | string | null;
    initial_prompt?: string | null;
  }) =>
    request<{ thread: AgentThread }>("/threads", { method: "POST", body: JSON.stringify(body) }),
  getThreadDetail: (id: string) => request<ThreadDetailResponse>(`/threads/${id}`),
  deleteThread: (id: string, removeWorktree = false) =>
    request<{ ok: boolean }>(`/threads/${id}?remove_worktree=${removeWorktree ? "1" : "0"}`, {
      method: "DELETE",
    }),
  listThreadEvents: (id: string, after = 0) =>
    request<{ events: ThreadEvent[] }>(`/threads/${id}/events?after=${after}&limit=500`),
  sendPrompt: (
    id: string,
    body: { prompt: string; delivery_mode?: ManagedDeliveryMode; room_id?: number | null },
  ) =>
    request<{ run: ThreadRun | null; steered?: boolean }>(`/threads/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  steerThread: (id: string, text: string) =>
    request<{ accepted: boolean; reason?: string }>(`/threads/${id}/steer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  interruptThread: (id: string) =>
    request<{ accepted: boolean; reason?: string }>(`/threads/${id}/interrupt`, { method: "POST" }),
  stopThread: (id: string) =>
    request<{ thread: AgentThread }>(`/threads/${id}/stop`, { method: "POST" }),
  resumeThread: (id: string) =>
    request<{ thread: AgentThread }>(`/threads/${id}/resume`, { method: "POST" }),
  switchThreadModel: (id: string, model: string) =>
    request<{ thread: AgentThread; hotSwitched: boolean }>(`/threads/${id}/model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    }),
  setApprovalMode: (id: string, approval_mode: ApprovalMode) =>
    request<{ thread: AgentThread }>(`/threads/${id}/approval-mode`, {
      method: "POST",
      body: JSON.stringify({ approval_mode }),
    }),
  forkAndHandoff: (
    id: string,
    body: {
      target_runtime: RuntimeId;
      model?: string | null;
      name?: string;
      prompt?: string;
      approval_mode?: ApprovalMode;
    },
  ) =>
    request<ForkHandoffResult>(`/threads/${id}/fork-handoff`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resolveApproval: (
    threadId: string,
    approvalId: number,
    body: { decision: ApprovalDecision; option_id?: string; answers?: Record<string, string | string[]> },
  ) =>
    request<{ ok: boolean }>(`/threads/${threadId}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listPendingApprovals: (roomId?: number) =>
    request<{ approvals: ThreadApproval[] }>(
      `/approvals/pending${roomId !== undefined ? `?room_id=${roomId}` : ""}`,
    ),
  rollbackCheckpoint: (threadId: string, checkpointId: number) =>
    request<{ ok: boolean; checkpoint_id: number }>(
      `/threads/${threadId}/checkpoints/${checkpointId}/rollback`,
      { method: "POST" },
    ),
  searchThreadFiles: (threadId: string, q: string) =>
    request<{ files: ProjectFileMatch[] }>(
      `/threads/${threadId}/files?q=${encodeURIComponent(q)}&limit=25`,
    ),

  // Workspace Git & PR
  getGitStatus: (threadId: string) => request<GitStatusResponse>(`/threads/${threadId}/git/status`),
  getGitDiff: (threadId: string, path?: string | null) =>
    request<GitDiffResponse>(
      `/threads/${threadId}/git/diff${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  stageGitFiles: (threadId: string, body: { paths?: string[]; staged: boolean }) =>
    request<GitStatusResponse>(`/threads/${threadId}/git/stage`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  commitGitChanges: (threadId: string, message: string) =>
    request<GitCommitResult>(`/threads/${threadId}/git/commit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  pushGitBranch: (threadId: string) =>
    request<GitPushResult>(`/threads/${threadId}/git/push`, { method: "POST" }),
  getPrDetail: (threadId: string) =>
    request<PrDetailResponse>(`/threads/${threadId}/git/pr-detail`),
  createWorktreePr: (
    threadId: string,
    body: { title?: string; body?: string; draft?: boolean } = {},
  ) =>
    request<GitCreatePrResult>(`/threads/${threadId}/git/pr`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  mergeGitPr: (
    threadId: string,
    body: { method?: "squash" | "merge" | "rebase"; cleanup_worktree?: boolean } = {},
  ) =>
    request<PrMergeResult>(`/threads/${threadId}/git/pr/merge`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  mergeWorktree: (threadId: string) =>
    request<GitMergeResult>(`/threads/${threadId}/git/merge`, { method: "POST" }),
  cleanupWorktree: (threadId: string) =>
    request<{ thread: AgentThread }>(`/threads/${threadId}/worktree/cleanup`, { method: "POST" }),

  // Workspace Tools: Embedded Terminal, File Explorer, Live Preview
  execTerminalCommand: (threadId: string, command: string) =>
    request<WorkspaceTerminalRunResult>(`/threads/${threadId}/terminal/exec`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
  listWorkspaceFiles: (threadId: string, path = "") =>
    request<{ entries: WorkspaceFileEntry[] }>(
      `/threads/${threadId}/fs/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  readWorkspaceFile: (threadId: string, path: string) =>
    request<WorkspaceFileContent>(
      `/threads/${threadId}/fs/read?path=${encodeURIComponent(path)}`,
    ),
  savePreviewUrl: (threadId: string, preview_url: string | null) =>
    request<{ thread: AgentThread }>(`/threads/${threadId}/preview`, {
      method: "PUT",
      body: JSON.stringify({ preview_url }),
    }),
  detectPreviewUrls: (threadId: string) =>
    request<{ detected: Array<{ port: number; url: string }>; saved_url: string | null }>(
      `/threads/${threadId}/preview/detect`,
    ),

  // Mica external terminal bridge
  getMicaStatus: () => request<MicaStatusResponse>("/mica/status"),
  listMicaPanes: () => request<{ running: boolean; panes: MicaPaneInfo[] }>("/mica/panes"),
  openInMica: (
    threadId: string,
    body: { mode?: "tab" | "window"; command?: string; force_new?: boolean } = {},
  ) =>
    request<{ pane: MicaPaneInfo; thread: AgentThread; reused: boolean }>(
      `/threads/${threadId}/mica/open`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  attachMicaPane: (threadId: string, pane_id: number) =>
    request<{ pane: MicaPaneInfo; thread: AgentThread }>(`/threads/${threadId}/mica/attach`, {
      method: "POST",
      body: JSON.stringify({ pane_id }),
    }),
  unbindMica: (threadId: string) =>
    request<{ thread: AgentThread }>(`/threads/${threadId}/mica`, { method: "DELETE" }),
  focusMica: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/mica/focus`, { method: "POST" }),
  sendMicaText: (threadId: string, body: { text: string; submit?: boolean; literal?: boolean }) =>
    request<{ ok: boolean }>(`/threads/${threadId}/mica/send`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  readMicaSnapshot: (threadId: string, opts: { scrollback?: boolean; lines?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.scrollback) qs.set("scrollback", "1");
    if (opts.lines) qs.set("lines", String(opts.lines));
    return request<MicaReadResult>(
      `/threads/${threadId}/mica/read${qs.toString() ? `?${qs.toString()}` : ""}`,
    );
  },
  setMicaBadge: (
    threadId: string,
    body: { state: MicaBadgeState; text?: string; sticky?: boolean },
  ) =>
    request<{ ok: boolean }>(`/threads/${threadId}/mica/badge`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Legacy room/context/workflow endpoints kept typed for non-breaking migration
  createRoom: (body: { name: string; description?: string; project_id?: number | null; members?: string[] }) =>
    request<{ room: Room }>("/rooms", { method: "POST", body: JSON.stringify(body) }),
  getRoomDetail: (roomId: number) =>
    request<{ room: Room; tasks: RoomTask[]; messages: Message[]; pending_approvals: ThreadApproval[] }>(
      `/rooms/${roomId}`,
    ),
  deleteRoom: (roomId: number) => request<{ ok: boolean }>(`/rooms/${roomId}`, { method: "DELETE" }),
  joinRoom: (roomId: number, thread_id: string) =>
    request<{ room: Room }>(`/rooms/${roomId}/join`, { method: "POST", body: JSON.stringify({ thread_id }) }),
  summonRoom: (roomId: number, body: { executor_thread_id: string; prompt: string; delivery_mode?: ManagedDeliveryMode }) =>
    request<{ task: RoomTask; message_id: number; delivered: boolean; delivery_method: string }>(
      `/rooms/${roomId}/summon`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  broadcastRoom: (roomId: number, prompt: string) =>
    request<{ room_id: number; dispatched: Array<{ thread_id: string; task_id: number }> }>(
      `/rooms/${roomId}/broadcast`,
      { method: "POST", body: JSON.stringify({ prompt }) },
    ),
  queryContext: (opts: { project_id?: number; room_id?: number; query?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.project_id !== undefined) qs.set("project_id", String(opts.project_id));
    if (opts.room_id !== undefined) qs.set("room_id", String(opts.room_id));
    if (opts.query) qs.set("query", opts.query);
    return request<{ entries: ContextEntry[] }>(`/context${qs.toString() ? `?${qs}` : ""}`);
  },
  publishContext: (body: {
    title: string;
    content: string;
    project_id?: number | null;
    room_id?: number | null;
    kind?: ContextKind;
    pinned?: boolean;
    tags?: string[];
  }) => request<{ entry: ContextEntry }>("/context", { method: "POST", body: JSON.stringify(body) }),
  updateContext: (
    id: number,
    body: { title?: string; content?: string; pinned?: boolean; kind?: ContextKind; expected_version?: number },
  ) => request<{ entry: ContextEntry }>(`/context/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteContext: (id: number) => request<{ ok: boolean }>(`/context/${id}`, { method: "DELETE" }),
  createWorkflow: (body: {
    name: string;
    description?: string | null;
    project_id?: number | null;
    room_id?: number | null;
    steps: WorkflowStepDefinition[];
  }) => request<{ workflow: WorkflowDefinition }>("/workflows", { method: "POST", body: JSON.stringify(body) }),
  deleteWorkflow: (id: number) => request<{ ok: boolean }>(`/workflows/${id}`, { method: "DELETE" }),
  listWorkflowRuns: (opts: { project_id?: number; workflow_id?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.project_id !== undefined) qs.set("project_id", String(opts.project_id));
    if (opts.workflow_id !== undefined) qs.set("workflow_id", String(opts.workflow_id));
    return request<{ runs: WorkflowRun[] }>(`/workflow-runs${qs.toString() ? `?${qs}` : ""}`);
  },
  startWorkflowRun: (workflowId: number, body: { input?: string; project_id?: number | null; room_id?: number | null }) =>
    request<{ run: WorkflowRun }>(`/workflows/${workflowId}/runs`, { method: "POST", body: JSON.stringify(body) }),
  approveWorkflowStep: (stepId: number, body: { approved: boolean; comment?: string }) =>
    request<{ run: WorkflowRun }>(`/workflow-steps/${stepId}/approve`, { method: "POST", body: JSON.stringify(body) }),
  handoffContext: (body: {
    from_thread: string;
    to_thread: string;
    project_id?: number | null;
    room_id?: number | null;
    title?: string;
    note?: string;
    prompt?: string;
    delivery_mode?: ManagedDeliveryMode;
  }) => request<HandoffResult>("/handoff", { method: "POST", body: JSON.stringify(body) }),
};
