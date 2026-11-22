import type {
  Agent,
  ChatRoom,
  CliBinaryStatus,
  ConfluxDataBundle,
  ContextEntry,
  Conversation,
  Graph,
  ManagedEventPayload,
  ManagedStatusResponse,
  Message,
  MessageStatus,
  ModelConfig,
  NativeCliProviderState,
  ProviderPreset,
  RuntimeAgent,
  RuntimeId,
  RuntimeInstance,
  SessionSummary,
  TerminalOption,
  TerminalSettings,
  Turn,
} from "@conflux/shared";
import { WEB_CONSOLE_ID } from "@conflux/shared";

async function get<T>(
  path: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = {};
  if (headers) init.headers = headers;
  if (signal) init.signal = signal;
  const res = await fetch(path, headers || signal ? init : undefined);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
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

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => get<{ ok: boolean }>("/healthz", undefined, signal),

  getGraph: (status = "all", signal?: AbortSignal) =>
    get<Graph>(`/graph?status=${encodeURIComponent(status)}`, undefined, signal),

  getMessages: (
    params?: {
      from?: string;
      to?: string;
      status?: MessageStatus | "all";
      since?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.status) qs.set("status", params.status);
    if (params?.since) qs.set("since", params.since);
    if (params?.limit) qs.set("limit", String(params.limit));
    return get<{ messages: Message[] }>(`/messages?${qs.toString()}`, undefined, signal);
  },

  checkInbox: (signal?: AbortSignal) =>
    get<{ inbox: Message[] }>("/messages/inbox", { "X-Session-Id": WEB_CONSOLE_ID }, signal),

  retryMessage: (id: number) =>
    post<{ message: Message; wake: { woke: boolean; reason?: string } }>(
      `/messages/${id}/retry`,
      {},
      { "X-Session-Id": WEB_CONSOLE_ID },
    ),

  getSessions: (status = "all", signal?: AbortSignal) =>
    get<{ sessions: SessionSummary[] }>(
      `/sessions?status=${encodeURIComponent(status)}`,
      undefined,
      signal,
    ),

  getPeerMessages: (peer: string, signal?: AbortSignal) =>
    get<{ messages: Message[] }>(
      `/web/peer-messages?peer=${encodeURIComponent(peer)}`,
      undefined,
      signal,
    ),

  getEdgeMessages: (edgeId: number, signal?: AbortSignal) =>
    get<{
      edge: { id: number; from: string; to: string };
      messages: Message[];
    }>(`/edges/${edgeId}/messages`, undefined, signal),

  edgeAsk: (edgeId: number, question: string) =>
    post<{ message: Message }>(`/edges/${edgeId}/ask`, { question }),

  getRuntimes: (signal?: AbortSignal) =>
    get<{
      runtimes: Record<string, { label: string; executable: string; executableEnv: string }>;
      agents: RuntimeAgent[];
    }>("/runtimes", undefined, signal),

  createRuntimeAgent: (body: {
    name: string;
    /** Any registry runtime id (server validates against RUNTIME_REGISTRY) */
    runtime: string;
    workdir?: string;
    model?: string;
    base_url?: string;
    api_key?: string;
    extra_env?: string;
    instructions?: string;
    interval_min?: number;
    /** codex-only: run as a Conflux-held app-server instead of a terminal */
    execution_mode?: "terminal" | "managed";
  }) => post<{ agent: RuntimeAgent }>("/runtimes", body),

  deleteRuntimeAgent: (id: number) => del<{ ok: boolean }>(`/runtimes/${id}`),

  startRuntimeAgent: (id: number) =>
    post<{ started: boolean; instance: RuntimeInstance }>(`/runtimes/${id}/start`, {}),

  getRuntimeInstances: (signal?: AbortSignal) =>
    get<{ instances: RuntimeInstance[] }>("/runtime-instances", undefined, signal),

  stopRuntimeInstance: (id: string) =>
    post<{ instance: RuntimeInstance }>(`/runtime-instances/${encodeURIComponent(id)}/stop`, {}),

  resumeRuntimeInstance: (id: string) =>
    post<{ started: boolean; instance: RuntimeInstance }>(
      `/runtime-instances/${encodeURIComponent(id)}/resume`,
      {},
    ),

  // ---- managed Codex executor ----

  getManagedStatus: (instanceId: string, signal?: AbortSignal) =>
    get<ManagedStatusResponse>(
      `/runtime-instances/${encodeURIComponent(instanceId)}/managed`,
      undefined,
      signal,
    ),

  getManagedEvents: (instanceId: string, after = 0, signal?: AbortSignal) =>
    get<{ events: ManagedEventPayload[] }>(
      `/runtime-instances/${encodeURIComponent(instanceId)}/managed/events?after=${after}`,
      undefined,
      signal,
    ),

  interruptManagedTurn: (instanceId: string, expectedTurnId?: string | null) =>
    post<{ accepted: boolean; reason?: string }>(
      `/runtime-instances/${encodeURIComponent(instanceId)}/managed/interrupt`,
      { expected_turn_id: expectedTurnId ?? undefined },
    ),

  resolveManagedApproval: (
    instanceId: string,
    approvalId: number,
    decision: "accept" | "decline" | "cancel",
  ) =>
    post<{ ok: boolean }>(
      `/runtime-instances/${encodeURIComponent(instanceId)}/managed/approvals/${approvalId}`,
      { decision },
      { "X-Session-Id": WEB_CONSOLE_ID },
    ),

  openSessionTerminal: (sessionId: string) =>
    post<{ opener: string }>(`/sessions/${encodeURIComponent(sessionId)}/open-terminal`, {}),

  getTerminalSettings: (signal?: AbortSignal) =>
    get<{
      terminal: TerminalSettings;
      options: TerminalOption[];
      binaries?: CliBinaryStatus[];
      auto_wake: boolean;
      wake_max_concurrent: number;
      wake_active_count: number;
    }>("/settings/terminal", undefined, signal),

  saveTerminalSettings: (
    body: Partial<TerminalSettings> & {
      auto_wake?: boolean;
      wake_max_concurrent?: number;
    },
  ) =>
    put<{
      terminal: TerminalSettings;
      binaries?: CliBinaryStatus[];
      auto_wake: boolean;
      wake_max_concurrent: number;
    }>("/settings/terminal", body),

  getCliProviders: (signal?: AbortSignal) =>
    get<{
      native: NativeCliProviderState[];
      presets: ProviderPreset[];
    }>("/settings/cli-providers", undefined, signal),

  saveCliProviderPreset: (body: {
    id?: string;
    name: string;
    runtime: RuntimeId;
    base_url?: string | null;
    model?: string | null;
    api_key?: string | null;
    extra_env?: string | null;
  }) =>
    post<{ preset: ProviderPreset; presets: ProviderPreset[] }>(
      "/settings/cli-providers/presets",
      body,
    ),

  deleteCliProviderPreset: (id: string) =>
    del<{ ok: boolean; presets: ProviderPreset[] }>(
      `/settings/cli-providers/presets/${encodeURIComponent(id)}`,
    ),

  applyCliProvider: (body: {
    preset_id?: string;
    runtime?: RuntimeId;
    base_url?: string | null;
    model?: string | null;
    api_key?: string | null;
    extra_env?: string | null;
  }) =>
    post<{
      ok: boolean;
      config_path: string;
      backup_path: string | null;
      native: NativeCliProviderState;
    }>("/settings/cli-providers/apply", body),

  webAsk: (body: { to_session: string; question: string; from_session?: string }) =>
    post<{ message: Message }>("/web/ask", body),

  getContext: (params?: { query?: string; session_id?: string; limit?: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params?.query) qs.set("query", params.query);
    if (params?.session_id) qs.set("session_id", params.session_id);
    if (params?.limit) qs.set("limit", String(params.limit));
    return get<{ entries: ContextEntry[] }>(`/context/query?${qs.toString()}`, { "X-Session-Id": WEB_CONSOLE_ID }, signal);
  },

  getAgents: (signal?: AbortSignal) => get<{ agents: Agent[] }>("/agents", undefined, signal),

  createAgent: (body: {
    name: string;
    system_prompt: string;
    model_config: ModelConfig;
    description?: string;
  }) => post<{ agent: Agent }>("/agents", body),

  deleteAgent: (id: number) => del<{ deleted: boolean }>(`/agents/${id}`),

  testProvider: (
    body: { provider: string; base_url?: string; api_key?: string; model?: string },
    signal?: AbortSignal,
  ) =>
    post<{ ok: boolean; error?: string; model?: string; response?: string }>(
      "/agents/test-provider",
      body,
      undefined,
      signal,
    ),

  getConversations: (agentId: number, signal?: AbortSignal) =>
    get<{ conversations: Conversation[] }>(`/agents/${agentId}/conversations`, undefined, signal),

  getTurns: (conversationId: number, signal?: AbortSignal) =>
    get<{ turns: Turn[] }>(`/conversations/${conversationId}/turns`, undefined, signal),

  deleteConversation: (id: number) => del<{ deleted: boolean }>(`/conversations/${id}`),

  getSettings: () => get<{ providers: Record<string, { configured: boolean }> }>("/settings"),

  exportData: (scope: "global" | "project" = "global") =>
    get<ConfluxDataBundle>(`/data/export?scope=${encodeURIComponent(scope)}`),

  importData: (bundle: ConfluxDataBundle, conflict: "skip" | "overwrite" | "copy" = "skip") =>
    post<{
      conflict: "skip" | "overwrite" | "copy";
      imported: number;
      skipped: number;
      overwritten: number;
      copied: number;
    }>("/data/import", { bundle, conflict }),

  dataCounts: () =>
    get<{ sessions: number; messages: number; contextEntries: number }>("/data/counts"),

  dataClear: (categories: { sessions?: boolean; messages?: boolean; context?: boolean }) =>
    post<{
      backupPath: string | null;
      cleared: { sessions: number; messages: number; contextEntries: number };
    }>("/data/clear", { categories }),

  streamChat: async (
    agentId: number,
    message: string,
    conversationId: number | null,
    onToken: (text: string) => void,
    onDone: (data: { conversation_id: number; turn_id: number }) => void,
    onError: (msg: string) => void,
    onToolUse?: (name: string, input: unknown) => void,
    onToolResult?: (name: string, result: unknown) => void,
    signal?: AbortSignal,
  ) => {
    const res = await fetch(`/agents/${agentId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversation_id: conversationId ?? undefined }),
      signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      onError(body.error ?? `HTTP ${res.status}`);
      return;
    }

    if (!res.body) throw new Error("聊天响应缺少数据流");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const dispatchPart = (part: string) => {
      const dataLine = part
        .split(/\r?\n/)
        .find((l) => l.startsWith("data: "));
      if (!dataLine) return;
      try {
        const data = JSON.parse(dataLine.slice(6));
        switch (data.type) {
          case "token":
            onToken(data.content);
            break;
          case "done":
            onDone(data);
            break;
          case "error":
            onError(data.message);
            break;
          case "tool_use":
            onToolUse?.(data.name, data.input);
            break;
          case "tool_result":
            onToolResult?.(data.name, data.result);
            break;
        }
      } catch {
        /* skip malformed */
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            for (const part of buffer.split(/\r?\n\r?\n/)) {
              if (part.trim()) dispatchPart(part);
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          dispatchPart(part);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },

  // ---- Chat Rooms ----
  chatRooms: {
    list: (signal?: AbortSignal) => get<{ rooms: ChatRoom[] }>("/chat-rooms", undefined, signal),
    create: (body: { name: string; description?: string; members: string[] }) =>
      post<{ room: ChatRoom }>("/chat-rooms", body),
    delete: (id: number) => del<{ ok: boolean }>(`/chat-rooms/${id}`),
    join: (roomId: number, sessionId: string) =>
      post<{ ok: boolean }>(`/chat-rooms/${roomId}/join`, { session_id: sessionId }),
    leave: (sessionId: string) =>
      post<{ ok: boolean }>("/chat-rooms/leave", { session_id: sessionId }),
    orchestrate: (roomId: number, signal?: AbortSignal) =>
      get<RoomOrchestration>(`/chat-rooms/${roomId}/orchestrate`, undefined, signal),
    summon: (roomId: number, executorSessionId: string, prompt: string, senderIdentity?: string) =>
      post<{ task_id: number; injected: boolean; method: string }>(`/chat-rooms/${roomId}/summon`, {
        executor_session_id: executorSessionId,
        prompt,
        sender_session_id: senderIdentity ?? WEB_CONSOLE_ID,
      }),
    broadcast: (roomId: number, prompt: string, senderIdentity?: string) =>
      post<{ room_id: number; members: string[]; message_ids: number[] }>(
        `/chat-rooms/${roomId}/broadcast`,
        { prompt, sender_session_id: senderIdentity ?? WEB_CONSOLE_ID },
      ),
    messages: (roomId: number, signal?: AbortSignal) =>
      get<{ messages: RoomThreadMessage[] }>(
        `/chat-rooms/${roomId}/messages`,
        undefined,
        signal,
      ),
  },
};

/** A room orchestration task: one prompt → one result, polled as a whole. */
export interface RoomTask {
  id: number;
  room_id: number;
  initiator_session_id: string;
  executor_session_id: string;
  prompt: string;
  status: "pending" | "running" | "done" | "failed";
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RoomOrchestration {
  tasks: RoomTask[];
  status: Array<{ executor_session_id: string; status: string; n: number }>;
}

/** One exchange on a room's shared broadcast thread. */
export interface RoomThreadMessage {
  id: number;
  room_id: number;
  from_session: string;
  to_session: string;
  from_name: string;
  to_name: string;
  question: string;
  reply: string | null;
  status: string;
  created_at: string;
}
