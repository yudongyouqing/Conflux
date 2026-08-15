import type { Graph, Message, MessageStatus, SessionSummary, ContextEntry, Agent, ModelConfig, Conversation, Turn } from "@muiltchat/shared";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<{ ok: boolean }>("/healthz"),

  getGraph: (status = "all") =>
    get<Graph>(`/graph?status=${encodeURIComponent(status)}`),

  getMessages: (params?: {
    from?: string;
    to?: string;
    status?: MessageStatus | "all";
    since?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.status) qs.set("status", params.status);
    if (params?.since) qs.set("since", params.since);
    if (params?.limit) qs.set("limit", String(params.limit));
    return get<{ messages: Message[] }>(`/messages?${qs.toString()}`);
  },

  getSessions: (status = "all") =>
    get<{ sessions: SessionSummary[] }>(`/sessions?status=${encodeURIComponent(status)}`),

  getPeerMessages: (peer: string) =>
    get<{ messages: Message[] }>(`/web/peer-messages?peer=${encodeURIComponent(peer)}`),

  webAsk: (body: { to_session: string; question: string }) =>
    post<{ message: Message }>("/web/ask", body),

  getContext: (params?: { query?: string; session_id?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.query) qs.set("query", params.query);
    if (params?.session_id) qs.set("session_id", params.session_id);
    if (params?.limit) qs.set("limit", String(params.limit));
    return get<{ entries: ContextEntry[] }>(`/context/query?${qs.toString()}`);
  },

  getAgents: () => get<{ agents: Agent[] }>("/agents"),

  createAgent: (body: {
    name: string;
    system_prompt: string;
    model_config: ModelConfig;
    description?: string;
  }) => post<{ agent: Agent }>("/agents", body),

  deleteAgent: (id: number) => del<{ deleted: boolean }>(`/agents/${id}`),

  getConversations: (agentId: number) =>
    get<{ conversations: Conversation[] }>(`/agents/${agentId}/conversations`),

  getTurns: (conversationId: number) =>
    get<{ turns: Turn[] }>(`/conversations/${conversationId}/turns`),

  deleteConversation: (id: number) =>
    del<{ deleted: boolean }>(`/conversations/${id}`),

  getSettings: () =>
    get<{ providers: Record<string, { configured: boolean }> }>("/settings"),

  streamChat: async (
    agentId: number,
    message: string,
    conversationId: number | null,
    onToken: (text: string) => void,
    onDone: (data: { conversation_id: number; turn_id: number }) => void,
    onError: (msg: string) => void,
    onToolUse?: (name: string, input: unknown) => void,
    onToolResult?: (name: string, result: unknown) => void,
  ) => {
    const res = await fetch(`/agents/${agentId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversation_id: conversationId ?? undefined }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      onError(body.error ?? `HTTP ${res.status}`);
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          switch (data.type) {
            case "token": onToken(data.content); break;
            case "done": onDone(data); break;
            case "error": onError(data.message); break;
            case "tool_use": onToolUse?.(data.name, data.input); break;
            case "tool_result": onToolResult?.(data.name, data.result); break;
          }
        } catch { /* skip malformed */ }
      }
    }
  },
};
