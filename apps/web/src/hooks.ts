import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export function useGraph() {
  return useQuery({
    queryKey: ["graph"],
    queryFn: () => api.getGraph("all"),
    refetchInterval: 5000,
  });
}

/** Active sessions for the @-mention picker (and their busy/status). */
export function useSessions(status: "active" | "all" = "active") {
  return useQuery({
    queryKey: ["sessions", status],
    queryFn: () => api.getSessions(status),
    refetchInterval: 5000,
  });
}

export function useMessages(filters?: { status?: string; limit?: number }) {
  return useQuery({
    queryKey: ["messages", filters],
    queryFn: () =>
      api.getMessages({
        status: (filters?.status as never) ?? "all",
        limit: filters?.limit ?? 100,
      }),
    refetchInterval: 3000,
  });
}

export function useDaemonHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 10000,
  });
}

export function useSessionContext(sessionId: string | null) {
  return useQuery({
    queryKey: ["context", sessionId],
    queryFn: () => api.getContext({ session_id: sessionId!, limit: 20 }),
    enabled: !!sessionId,
    refetchInterval: 10000,
  });
}

/** Two-way message flow between the web console and one session (Drawer view). */
export function usePeerMessages(peer: string | null) {
  return useQuery({
    queryKey: ["peer-messages", peer],
    queryFn: () => api.getPeerMessages(peer!),
    enabled: !!peer,
    refetchInterval: 5000,
  });
}

/** One conversation channel's (edge) exchange history. */
export function useEdgeMessages(edgeId: number | null) {
  return useQuery({
    queryKey: ["edge-messages", edgeId],
    queryFn: () => api.getEdgeMessages(edgeId!),
    enabled: edgeId !== null,
    refetchInterval: 5000,
  });
}

/** Speak on a web-console channel. */
export function useEdgeAsk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ edgeId, question }: { edgeId: number; question: string }) =>
      api.edgeAsk(edgeId, question),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["edge-messages", vars.edgeId] });
      qc.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

/** Two-way message flow between any two sessions (graph edge click). */
export function usePeerFlow(a: string | null, b: string | null) {
  return useQuery({
    queryKey: ["peer-flow", a, b],
    queryFn: () => api.getPeerFlow(a!, b!),
    enabled: !!a && !!b,
    refetchInterval: 5000,
  });
}

/** Send a question to a session as the web console. */
export function useWebAsk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.webAsk,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["peer-messages"] });
      qc.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api.getAgents(),
    refetchInterval: 10000,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

// ---- runtime agents (CLI presets: Claude Code / Codex) ----

export function useRuntimes() {
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: () => api.getRuntimes(),
    refetchInterval: 10000,
  });
}

export function useCreateRuntimeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createRuntimeAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runtimes"] }),
  });
}

export function useDeleteRuntimeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteRuntimeAgent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runtimes"] }),
  });
}

export function useStartRuntimeAgent() {
  return useMutation({
    mutationFn: api.startRuntimeAgent,
  });
}

// ---- terminal settings + open-in-terminal ----

export function useTerminalSettings() {
  return useQuery({
    queryKey: ["terminal-settings"],
    queryFn: () => api.getTerminalSettings(),
  });
}

export function useSaveTerminalSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.saveTerminalSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminal-settings"] }),
  });
}

export function useOpenSessionTerminal() {
  return useMutation({
    mutationFn: api.openSessionTerminal,
  });
}
