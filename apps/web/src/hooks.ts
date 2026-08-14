import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export function useGraph() {
  return useQuery({
    queryKey: ["graph"],
    queryFn: () => api.getGraph("all"),
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
