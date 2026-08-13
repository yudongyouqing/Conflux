export type SessionStatus = "active" | "stale" | "ended";

export interface GraphNode {
  id: string;
  name: string;
  status: SessionStatus;
  type: "session";
  context_count: number;
  pending_inbox: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  last_interact_at: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type MessageStatus = "pending" | "replied" | "read";

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

export interface Session {
  id: string;
  name: string;
  description: string | null;
  project_dir: string | null;
  status: SessionStatus;
  created_at: string;
  last_heartbeat_at: string;
  metadata: string | null;
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
  provider: string;
  model: string;
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
