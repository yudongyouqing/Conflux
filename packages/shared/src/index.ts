/**
 * Shared types for muiltchat — the single source of truth.
 *
 * Consumed by apps/server (core modules, type-only imports) and apps/web.
 * When the backend changes a response field, the frontend compile breaks
 * here instead of silently drifting.
 */

export type SessionStatus = "active" | "stale" | "ended";

export type NodeType = "session" | "agent";

/**
 * Message lifecycle: pending (unseen by addressee) -> seen (read but not
 * yet answered) -> replied (answer written) -> read (asker consumed the
 * reply). "seen" distinguishes "looked at, still composing" from "never
 * opened".
 */
export type MessageStatus = "pending" | "seen" | "replied" | "read";

export interface Session {
  id: string;
  name: string;
  description: string | null;
  project_dir: string | null;
  status: SessionStatus;
  created_at: string;
  last_heartbeat_at: string;
  metadata: string | null;
}

export interface SessionSummary extends Session {
  context_count: number;
  pending_inbox: number;
}

export interface ContextEntry {
  id: number;
  session_id: string;
  title: string;
  content: string;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface ModelConfig {
  provider: string; // "anthropic" | "openai" | ...
  model: string; // e.g. "claude-sonnet-4-20250514"
  temperature?: number;
  max_tokens?: number;
}

export interface Agent {
  id: number;
  name: string;
  system_prompt: string;
  model_config: ModelConfig;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export type RuntimeId = "claude" | "codex";

/** How muiltchat opens a new terminal window (AgentRecall-style choice). */
export type TerminalChoice =
  | "wt"
  | "powershell"
  | "cmd"
  | "wezterm"
  /** macOS Terminal.app */
  | "terminal"
  /** macOS iTerm2 */
  | "iterm"
  /** tmux window in the tmux server (attach from any terminal) */
  | "tmux";

export interface TerminalSettings {
  /** Terminal opener. wt falls back to cmd when wt.exe is missing. */
  terminal: TerminalChoice;
  /** Claude Code executable override (default "claude"). */
  claude_path: string;
  /** Codex executable override (default "codex"). */
  codex_path: string;
}

/** One dropdown entry in the settings UI, with live availability. */
export interface TerminalOption {
  value: TerminalChoice;
  label: string;
  hint: string;
  /** Whether any of the opener's executables was found on PATH. */
  available: boolean;
}

/**
 * User-configured runtime agent: a preset for spawning a real CLI agent
 * (Claude Code / Codex) with a fixed working directory and API channel.
 * AgentRecall-inspired: runtime + channel (API config) + instructions.
 */
export interface RuntimeAgent {
  id: number;
  name: string;
  runtime: RuntimeId;
  workdir: string | null;
  model: string | null;
  base_url: string | null;
  api_key: string | null;
  /** JSON object string of extra environment variables. */
  extra_env: string | null;
  instructions: string | null;
  /** Scheduled wake-up interval in minutes; null/0 = manual start only. */
  interval_min: number | null;
  /** ISO timestamp of the last scheduled headless run. */
  last_scheduled_run: string | null;
  /** Derived: does any spawned session of this preset have a fresh heartbeat? */
  live?: boolean;
  /** Derived: newest heartbeat across this preset's sessions (ISO). */
  last_seen?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GraphNode {
  id: string;
  name: string;
  status: SessionStatus;
  type: NodeType;
  context_count: number;
  pending_inbox: number;
  conversation_count?: number;
  description?: string | null;
  /** Working directory of the session (external sessions only). */
  project_dir?: string | null;
  /** ISO timestamp of the last heartbeat (external sessions only). */
  last_heartbeat_at?: string;
  /** Runtime-agent definition this session was spawned from (if any). */
  agent_id?: number | null;
  /** CLI runtime identifier, e.g. "claude" | "codex" (runtime-agent sessions). */
  runtime?: string | null;
  /** Agent Card: capability self-description (register_session skills). */
  skills?: string[];
}

/**
 * Edge = a directed conversation CHANNEL: `from` initiated it and speaks,
 * `to` answers. Replies stay on the same channel (no reverse edge).
 */
export interface GraphEdge {
  /** Channel id (edges.rowid). */
  id: number;
  from: string;
  to: string;
  /** Number of exchanges (asks) on this channel. */
  weight: number;
  last_interact_at: string;
  /** Latest question on this channel; "↩ ..." when the channel only ever carried a reply. */
  last_message?: string | null;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Message {
  id: number;
  /** The conversation channel (edge) this exchange belongs to. */
  edge_id?: number | null;
  from_session: string;
  to_session: string;
  question: string;
  reply: string | null;
  status: MessageStatus;
  created_at: string;
  replied_at: string | null;
}

export interface Conversation {
  id: number;
  agent_id: number;
  initiated_by: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface Turn {
  id: number;
  conversation_id: number;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}
