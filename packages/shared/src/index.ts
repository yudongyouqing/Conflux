/**
 * Shared TypeScript contracts for Conflux v2 (Project -> Agent Thread architecture).
 *
 * Single source of truth consumed by apps/server, apps/web, and MCP/CLI surfaces.
 */

export const WEB_CONSOLE_ID = "web-console";
export const WEB_CONSOLE_NAME = "Web 控制台";
export const WEB_CONSOLE_DESCRIPTION = "Conflux 桌面 / Web 控制台";

export type RuntimeId = "claude" | "codex" | "antigravity" | "acp";

export type ThreadKind = "managed" | "external";

export type ThreadState = "idle" | "running" | "waiting_approval" | "stopped" | "error";

export type ApprovalMode = "ask" | "auto";

export type IncomingCallMode = "auto" | "ask" | "dnd";

export type WorkspaceCreateMode = "direct" | "worktree" | "pr";

export type ManagedDeliveryMode = "queue" | "steer" | "interrupt";

export type ManagedApprovalKind = "commandExecution" | "fileChange" | "userInput" | "toolCall";

export type ApprovalDecision = "accept" | "decline" | "cancel";

export type ApprovalState = "pending" | "resolved" | "auto_approved" | "expired";

export type ThreadRunState =
  | "queued"
  | "submitting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export type ThreadEventType =
  | "user"
  | "text"
  | "thinking"
  | "tool"
  | "approval"
  | "status"
  | "error";

export type ContextKind = "note" | "decision" | "artifact" | "summary" | "handoff";

export type MessageStatus =
  | "pending"
  | "awaiting_approval"
  | "seen"
  | "replied"
  | "read"
  | "cancelled";

export type RoomTaskStatus = "pending" | "running" | "done" | "failed";

export type WorkflowStepKind = "agent" | "human_gate";

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_human"
  | "done"
  | "failed"
  | "skipped";

export type LiveEventType =
  | "project.updated"
  | "thread.updated"
  | "thread.event"
  | "approval.updated"
  | "peer.message"
  | "room.message"
  | "room.task"
  | "workflow.updated"
  | "context.updated"
  | "git.dirty"
  | "mica.updated";

export interface Project {
  id: number;
  name: string;
  root_path: string;
  default_branch: string | null;
  is_git_repo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectFileMatch {
  path: string;
  name: string;
}

export interface AgentThread {
  id: string;
  project_id: number | null;
  name: string;
  kind: ThreadKind;
  runtime: RuntimeId;
  state: ThreadState;
  approval_mode: ApprovalMode;
  incoming_call_mode: IncomingCallMode;
  host: string;
  workdir: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_branch: string | null;
  pr_url?: string | null;
  preview_url?: string | null;
  external_session_id?: string | null;
  model: string | null;
  instructions: string | null;
  extra_env: string | null;
  provider_thread_id: string | null;
  active_turn_id: string | null;
  pid: number | null;
  parent_thread_id: string | null;
  last_synced_context_id: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  /** Bound external Mica terminal pane, if any. */
  mica_pane_id?: number | null;
  /** Derived runtime metadata populated by list/detail queries. */
  live?: boolean;
  supports_steer?: boolean;
  pending_approvals?: number;
  project_name?: string | null;
  room_ids?: number[];
}

export interface AgentTemplate {
  id: number;
  name: string;
  runtime: RuntimeId;
  model: string | null;
  instructions: string | null;
  extra_env: string | null;
  approval_mode: ApprovalMode;
  use_worktree: boolean;
  created_at: string;
  updated_at: string;
}

export interface ThreadRun {
  id: number;
  thread_id: string;
  message_id: number | null;
  room_id: number | null;
  prompt: string;
  state: ThreadRunState;
  turn_id: string | null;
  final_text: string | null;
  error_code: string | null;
  checkpoint_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadEvent {
  seq: number;
  thread_id: string;
  run_id: number | null;
  type: ThreadEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ThreadApproval {
  id: number;
  thread_id: string;
  run_id: number;
  kind: ManagedApprovalKind;
  payload: Record<string, unknown>;
  state: ApprovalState;
  decision: ApprovalDecision | null;
  response_json: string | null;
  created_at: string;
  resolved_at: string | null;
  thread_name?: string;
  runtime?: RuntimeId;
  project_id?: number | null;
  room_id?: number | null;
}

export interface ThreadCheckpoint {
  id: number;
  thread_id: string;
  run_id: number | null;
  ref_name: string;
  tree_sha: string;
  commit_sha: string;
  summary: string | null;
  created_at: string;
}

export interface ThreadDetailResponse {
  thread: AgentThread;
  runs: ThreadRun[];
  pending_approvals: ThreadApproval[];
  checkpoints: ThreadCheckpoint[];
  queued_run_ids: number[];
}

export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitStatusResponse {
  is_git_repo: boolean;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  dirty: boolean;
  files: GitFileChange[];
  ahead?: number;
  behind?: number;
  gh_available?: boolean;
}

export interface GitDiffResponse {
  path: string | null;
  diff: string;
  truncated: boolean;
}

export interface GitMergeResult {
  ok: boolean;
  merged_branch: string;
  target_branch: string;
  conflicts?: string[];
  message: string;
}

export interface GitCreatePrResult {
  ok: boolean;
  branch: string;
  base_branch: string;
  pr_url: string | null;
  existing?: boolean;
  message: string;
}

export interface GitCommitResult {
  ok: boolean;
  commit_sha: string | null;
  message: string;
}

export interface GitPushResult {
  ok: boolean;
  branch: string | null;
  message: string;
}

export interface PrCheckItem {
  name: string;
  status: "pass" | "fail" | "pending";
  duration?: string | null;
  url?: string | null;
  description?: string | null;
}

export interface PrReviewComment {
  id: string;
  author: string;
  path?: string | null;
  line?: number | null;
  body: string;
  created_at?: string | null;
  url?: string | null;
}

export interface PrDetailInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  head_branch: string;
  base_branch: string;
  is_draft: boolean;
  checks: PrCheckItem[];
  comments: PrReviewComment[];
}

export interface PrDetailResponse {
  gh_available: boolean;
  pr: PrDetailInfo | null;
  message?: string | null;
}

export interface PrMergeResult {
  ok: boolean;
  message: string;
  pr_number?: number | null;
}

export interface WorkspaceTerminalRunResult {
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export interface SystemNetworkInfo {
  hostname: string;
  addresses: string[];
  preferred_ip: string;
  port: number;
  mcp_http_url: string;
  hub_url: string;
}

export interface CliProbeEntry {
  runtime: RuntimeId;
  label: string;
  executable: string;
  available: boolean;
  resolved_path: string | null;
  version: string | null;
  models: string[];
  supports_steer: boolean;
}

export interface RuntimeSettings {
  claude_path: string;
  codex_path: string;
  antigravity_path: string;
  acp_path: string;
  mica_path: string;
  max_autonomous_hops: number;
  pair_cooldown_ms: number;
}

export interface Room {
  id: number;
  project_id: number | null;
  name: string;
  description: string | null;
  members: string[];
  created_at: string;
  updated_at: string;
}

export interface RoomTask {
  id: number;
  room_id: number;
  initiator_thread_id: string;
  executor_thread_id: string;
  prompt: string;
  status: RoomTaskStatus;
  summary: string | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  edge_id: number | null;
  from_session: string;
  to_session: string;
  from_name?: string;
  to_name?: string;
  from_host?: string;
  to_host?: string;
  question: string;
  context?: string | null;
  reply: string | null;
  status: MessageStatus;
  room_id: number | null;
  trace_id?: string | null;
  hop_count: number;
  created_at: string;
  replied_at: string | null;
}

export interface ContextEntry {
  id: number;
  thread_id: string;
  project_id: number | null;
  room_id: number | null;
  kind: ContextKind;
  pinned: boolean;
  title: string;
  content: string;
  tags: string[] | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStepDefinition {
  key: string;
  title: string;
  kind: WorkflowStepKind;
  depends_on: string[];
  target_thread_id?: string | null;
  prompt_template: string;
  include_handoff?: boolean;
}

export interface WorkflowDefinition {
  id: number;
  name: string;
  description: string | null;
  project_id: number | null;
  room_id: number | null;
  steps: WorkflowStepDefinition[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowStepState {
  id: number;
  run_id: number;
  step_key: string;
  title: string;
  kind: WorkflowStepKind;
  depends_on: string[];
  target_thread_id: string | null;
  prompt_template: string;
  include_handoff: boolean;
  status: WorkflowStepStatus;
  message_id: number | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  workflow_name?: string;
  project_id: number | null;
  room_id: number | null;
  status: WorkflowRunStatus;
  input: string | null;
  initiated_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  steps: WorkflowStepState[];
}

export interface HandoffResult {
  context_entry: ContextEntry;
  message_id: number | null;
  delivered: boolean;
  delivery_method: string;
  summary_chars: number;
}

export interface ForkHandoffResult {
  source_thread: AgentThread;
  target_thread: AgentThread;
  context_entry: ContextEntry;
  run: ThreadRun | null;
  summary_chars: number;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: ThreadKind | "console";
  runtime: RuntimeId | "web";
  state: ThreadState;
  host: string;
  incoming_call_mode: IncomingCallMode;
  external_session_id?: string | null;
  project_id: number | null;
  project_name: string | null;
  workdir: string | null;
  worktree_branch: string | null;
  pending_approvals: number;
  context_count: number;
  room_ids: number[];
  live?: boolean;
}

export interface GraphEdge {
  id: number;
  from: string;
  to: string;
  weight: number;
  last_interact_at: string;
  last_message?: string | null;
  last_message_id?: number | null;
  last_status?: MessageStatus | null;
  trace_id?: string | null;
  hop_count?: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LiveEventEnvelope {
  id: number;
  type: LiveEventType;
  project_id?: number | null;
  thread_id?: string | null;
  room_id?: number | null;
  workflow_run_id?: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface WorkspaceTreeResponse {
  projects: Project[];
  threads: AgentThread[];
  rooms: Room[];
  workflows: WorkflowDefinition[];
  pending_approvals: ThreadApproval[];
  cli_probes: CliProbeEntry[];
}

// ---- Mica external terminal bridge (L1 control-plane) ----

export type MicaBadgeState = "none" | "idle" | "running" | "attention";

export type MicaPromptState = "unknown" | "idle" | "running";

export interface MicaPaneBadge {
  state: MicaBadgeState;
  text: string | null;
  sticky: boolean;
}

export interface MicaPaneInfo {
  window_id: number;
  tab_index: number;
  pane_id: number;
  pid: number | null;
  cwd: string | null;
  title: string;
  is_active: boolean;
  is_focused: boolean;
  is_quick_terminal: boolean;
  prompt_state: MicaPromptState;
  last_exit_code: number | null;
  badge: MicaPaneBadge | null;
}

export interface MicaReadResult {
  pane_id: number;
  cols: number;
  rows: number;
  text: string;
  truncated: boolean;
}

export interface MicaStatusResponse {
  available: boolean;
  running: boolean;
  executable: string;
  panes: MicaPaneInfo[];
}

export type MicaWatchEventType =
  | "pane_created"
  | "pane_exited"
  | "pane_closed"
  | "cwd_changed"
  | "title_changed"
  | "prompt_state_changed"
  | "badge_changed";

export interface MicaWatchEvent {
  type: MicaWatchEventType;
  window_id?: number;
  tab_index?: number;
  pane_id?: number;
  pid?: number | null;
  cwd?: string | null;
  exit_code?: number | null;
  title?: string;
  prompt_state?: MicaPromptState;
  badge?: MicaPaneBadge | null;
}
