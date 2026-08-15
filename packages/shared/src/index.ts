/**
 * Shared types for muiltchat — the single source of truth.
 *
 * Consumed by apps/server (core modules, type-only imports) and apps/web.
 * When the backend changes a response field, the frontend compile breaks
 * here instead of silently drifting.
 */

export type SessionStatus = "active" | "stale" | "ended";

export type NodeType = "session" | "agent";

export type MessageStatus = "pending" | "replied" | "read";

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
}

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  last_interact_at: string;
  /** Latest question exchanged over this channel (either direction), if any. */
  last_message?: string | null;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Message {
  id: number;
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
