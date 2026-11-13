import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ManagedEventPayload } from "@conflux/shared";
import { api } from "./api";

export type ManagedEvent = ManagedEventPayload;

export function useGraph() {
  return useQuery({
    queryKey: ["graph"],
    queryFn: () => api.getGraph("all"),
    refetchInterval: 5000,
  });
}

/** Active sessions for the @-mention picker (and their busy/status). */
export function useSessions(status: "active" | "all" = "active", enabled = true) {
  return useQuery({
    queryKey: ["sessions", status],
    queryFn: ({ signal }) => api.getSessions(status, signal),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
}

export function useMessages(filters?: { status?: string; limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ["messages", filters],
    queryFn: async ({ signal }) => {
      // Auto-mark pending messages addressed to web-console as seen. The
      // preflight is part of the queryFn so a hidden activity page (enabled
      // false) never fires read side effects from the background.
      try {
        await api.checkInbox(signal);
      } catch {
        // web-console might not be registered yet; ignore and proceed
      }
      return api.getMessages(
        {
          status: (filters?.status as never) ?? "all",
          limit: filters?.limit ?? 100,
        },
        signal,
      );
    },
    enabled,
    refetchInterval: 3000,
  });
}

export function useRetryMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.retryMessage,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["messages"] }),
        qc.invalidateQueries({ queryKey: ["peer-messages"] }),
        qc.invalidateQueries({ queryKey: ["edge-messages"] }),
        qc.invalidateQueries({ queryKey: ["graph"] }),
      ]),
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
export function usePeerMessages(peer: string | null, enabled = true) {
  return useQuery({
    queryKey: ["peer-messages", peer],
    queryFn: ({ signal }) => api.getPeerMessages(peer!, signal),
    enabled: !!peer && enabled,
    refetchInterval: 5000,
  });
}

/** One conversation channel's (edge) exchange history. */
export function useEdgeMessages(edgeId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["edge-messages", edgeId],
    queryFn: ({ signal }) => api.getEdgeMessages(edgeId!, signal),
    enabled: edgeId !== null && enabled,
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
export function useAgents(enabled = true) {
  return useQuery({
    queryKey: ["agents"],
    queryFn: ({ signal }) => api.getAgents(signal),
    enabled,
    refetchInterval: enabled ? 10000 : false,
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

export function useRuntimes(enabled = true) {
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: ({ signal }) => api.getRuntimes(signal),
    enabled,
    refetchInterval: enabled ? 10000 : false,
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.startRuntimeAgent,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["runtimes"] }),
        qc.invalidateQueries({ queryKey: ["runtime-instances"] }),
      ]),
  });
}

export function useRuntimeInstances(enabled = true) {
  return useQuery({
    queryKey: ["runtime-instances"],
    queryFn: ({ signal }) => api.getRuntimeInstances(signal),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
}

function useRuntimeInstanceMutation(
  action: typeof api.stopRuntimeInstance | typeof api.resumeRuntimeInstance,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["runtime-instances"] }),
        qc.invalidateQueries({ queryKey: ["runtimes"] }),
        qc.invalidateQueries({ queryKey: ["sessions"] }),
        qc.invalidateQueries({ queryKey: ["graph"] }),
      ]),
  });
}

export function useStopRuntimeInstance() {
  return useRuntimeInstanceMutation(api.stopRuntimeInstance);
}

export function useResumeRuntimeInstance() {
  return useRuntimeInstanceMutation(api.resumeRuntimeInstance);
}

// ---- managed Codex executor ----

/** Live status of one managed instance (binding, current run, approvals). */
export function useManagedStatus(instanceId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["managed-status", instanceId],
    queryFn: ({ signal }) => api.getManagedStatus(instanceId!, signal),
    enabled: !!instanceId && enabled,
    refetchInterval: enabled ? 4000 : false,
  });
}

/** Incremental event replay: each poll fetches only sequences after the
 *  cursor, so reconnects/switches never duplicate rendered events. */
export function useManagedEvents(instanceId: string | null, enabled = true) {
  return useQuery<ManagedEvent[], Error>({
    queryKey: ["managed-events", instanceId],
    enabled: !!instanceId && enabled,
    refetchInterval: enabled ? 2000 : false,
    queryFn: async ({ signal, client }) => {
      const key = ["managed-events-cursor", instanceId] as const;
      const cursor = (client.getQueryData(key) as number | undefined) ?? 0;
      const res = await api.getManagedEvents(instanceId!, cursor, signal);
      const maxSeq = res.events.reduce((m, e) => Math.max(m, e.sequence), cursor);
      if (maxSeq !== cursor) client.setQueryData(key, maxSeq);
      // Merge with whatever the cache already holds (same key), newest last.
      const prev =
        (client.getQueryData(["managed-events", instanceId]) as ManagedEvent[] | undefined) ?? [];
      const seen = new Set(prev.map((e) => e.sequence));
      const merged = [...prev, ...res.events.filter((e) => !seen.has(e.sequence))];
      return merged.slice(-500);
    },
  });
}

export function useInterruptManagedTurn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      instanceId,
      expectedTurnId,
    }: {
      instanceId: string;
      expectedTurnId?: string | null;
    }) => api.interruptManagedTurn(instanceId, expectedTurnId),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["managed-status", vars.instanceId] });
      qc.invalidateQueries({ queryKey: ["managed-events", vars.instanceId] });
    },
  });
}

export function useResolveManagedApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      instanceId,
      approvalId,
      decision,
    }: {
      instanceId: string;
      approvalId: number;
      decision: "accept" | "decline" | "cancel";
    }) => api.resolveManagedApproval(instanceId, approvalId, decision),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["managed-status", vars.instanceId] });
      qc.invalidateQueries({ queryKey: ["managed-events", vars.instanceId] });
    },
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
