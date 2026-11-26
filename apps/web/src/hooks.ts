import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export function useWorkspaceTree() {
  return useQuery({
    queryKey: ["workspace-tree"],
    queryFn: api.getWorkspaceTree,
    refetchInterval: 12_000,
  });
}

export function useNetworkInfo() {
  return useQuery({
    queryKey: ["system-network"],
    queryFn: api.getNetworkInfo,
    staleTime: 60_000,
  });
}

export function useMeshCalls(status: "active" | "history" | "all" = "all") {
  return useQuery({
    queryKey: ["mesh-calls", status],
    queryFn: () => api.listMeshCalls(status, 120),
    refetchInterval: 5_000,
  });
}

export function useThreadDetail(threadId: string | null) {
  return useQuery({
    queryKey: ["thread-detail", threadId],
    queryFn: () => api.getThreadDetail(threadId!),
    enabled: Boolean(threadId),
    refetchInterval: 8_000,
  });
}

export function useThreadEvents(threadId: string | null) {
  return useQuery({
    queryKey: ["thread-events", threadId],
    queryFn: () => api.listThreadEvents(threadId!),
    enabled: Boolean(threadId),
    refetchInterval: 4_000,
  });
}

export function useThreadGitStatus(threadId: string | null) {
  return useQuery({
    queryKey: ["thread-git-status", threadId],
    queryFn: () => api.getGitStatus(threadId!),
    enabled: Boolean(threadId),
    refetchInterval: 10_000,
  });
}

export function useThreadGitDiff(threadId: string | null, filePath: string | null) {
  return useQuery({
    queryKey: ["thread-git-diff", threadId, filePath],
    queryFn: () => api.getGitDiff(threadId!, filePath),
    enabled: Boolean(threadId),
  });
}

export function useThreadPrDetail(threadId: string | null) {
  return useQuery({
    queryKey: ["thread-pr-detail", threadId],
    queryFn: () => api.getPrDetail(threadId!),
    enabled: Boolean(threadId),
    refetchInterval: 30_000,
  });
}

export function useWorkspaceFiles(threadId: string | null, subPath: string) {
  return useQuery({
    queryKey: ["workspace-files", threadId, subPath],
    queryFn: () => api.listWorkspaceFiles(threadId!, subPath),
    enabled: Boolean(threadId),
  });
}

export function useWorkspaceFileContent(threadId: string | null, filePath: string | null) {
  return useQuery({
    queryKey: ["workspace-file-content", threadId, filePath],
    queryFn: () => api.readWorkspaceFile(threadId!, filePath!),
    enabled: Boolean(threadId && filePath),
  });
}

export function useDetectPreview(threadId: string | null) {
  return useQuery({
    queryKey: ["workspace-preview-detect", threadId],
    queryFn: () => api.detectPreviewUrls(threadId!),
    enabled: Boolean(threadId),
    refetchInterval: 20_000,
  });
}

export function useRoomDetail(roomId: number | null) {
  return useQuery({
    queryKey: ["room-detail", roomId],
    queryFn: () => api.getRoomDetail(roomId!),
    enabled: roomId !== null,
    refetchInterval: 6_000,
  });
}

export function useContextEntries(opts: { project_id?: number; room_id?: number }) {
  return useQuery({
    queryKey: ["context", opts.project_id ?? null, opts.room_id ?? null],
    queryFn: () => api.queryContext(opts),
    enabled: opts.project_id !== undefined || opts.room_id !== undefined,
  });
}

export function useWorkflowRuns(workflowId?: number) {
  return useQuery({
    queryKey: ["workflow-runs", workflowId ?? "all"],
    queryFn: () => api.listWorkflowRuns(workflowId ? { workflow_id: workflowId } : {}),
    refetchInterval: 6_000,
  });
}

export function useGraph() {
  return useQuery({
    queryKey: ["graph"],
    queryFn: api.getGraph,
    refetchInterval: 6_000,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: ["templates"],
    queryFn: api.listTemplates,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });
}

export function useInvalidateWorkspace() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    void qc.invalidateQueries({ queryKey: ["graph"] });
    void qc.invalidateQueries({ queryKey: ["mesh-calls"] });
  };
}

export function useCreateProject() {
  const invalidate = useInvalidateWorkspace();
  return useMutation({
    mutationFn: api.createProject,
    onSuccess: invalidate,
  });
}

export function useCreateThread() {
  const invalidate = useInvalidateWorkspace();
  return useMutation({
    mutationFn: api.createThread,
    onSuccess: invalidate,
  });
}

export function useResolveApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      threadId: string;
      approvalId: number;
      decision: "accept" | "decline" | "cancel";
      option_id?: string;
      answers?: Record<string, string | string[]>;
    }) =>
      api.resolveApproval(vars.threadId, vars.approvalId, {
        decision: vars.decision,
        option_id: vars.option_id,
        answers: vars.answers,
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
      void qc.invalidateQueries({ queryKey: ["thread-detail", vars.threadId] });
      void qc.invalidateQueries({ queryKey: ["thread-events", vars.threadId] });
    },
  });
}
