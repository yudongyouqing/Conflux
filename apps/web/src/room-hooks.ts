import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";

const ROOM_LIST_INTERVAL_MS = 5000;
const ROOM_THREAD_INTERVAL_MS = 3000;

/**
 * Room queries for the chat-first workspace. Every hook takes an explicit
 * enable condition so hidden surfaces stop polling instead of silently
 * continuing in the background, and read paths forward the Query-provided
 * AbortSignal so a target switch cancels in-flight reads rather than letting
 * them land on the wrong room's cache.
 */

/** Room ids are the server's own resource ids; 0 or negative values are UI
 * placeholders that must never become requests. */
export function isQueryableRoomId(roomId: number | null | undefined): roomId is number {
  return typeof roomId === "number" && Number.isInteger(roomId) && roomId > 0;
}

export function useChatRooms(enabled = true) {
  return useQuery({
    queryKey: ["chat-rooms"],
    queryFn: ({ signal }) => api.chatRooms.list(signal),
    enabled,
    refetchInterval: enabled ? ROOM_LIST_INTERVAL_MS : false,
  });
}

export function useRoomMessages(roomId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["room-messages", roomId],
    queryFn: ({ signal }) => api.chatRooms.messages(roomId!, signal),
    enabled: isQueryableRoomId(roomId) && enabled,
    refetchInterval: enabled ? ROOM_THREAD_INTERVAL_MS : false,
  });
}

export function useRoomTasks(roomId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["room-tasks", roomId],
    queryFn: ({ signal }) => api.chatRooms.orchestrate(roomId!, signal),
    enabled: isQueryableRoomId(roomId) && enabled,
    refetchInterval: enabled ? ROOM_THREAD_INTERVAL_MS : false,
  });
}

/** Room membership changes must refresh the room list and the shared graph
 * (membership is graph-visible), and nothing else. */
function invalidateRoomListAndGraph(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["chat-rooms"] }),
    qc.invalidateQueries({ queryKey: ["graph"] }),
  ]);
}

/** A send only refreshes the room it was submitted to — identified by the
 * mutation variables captured at submit time, never the currently rendered
 * target, which may already be somewhere else when the response lands. */
function invalidateRoomThread(qc: QueryClient, roomId: number) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["room-tasks", roomId] }),
    qc.invalidateQueries({ queryKey: ["room-messages", roomId] }),
  ]);
}

export function useCreateRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; members: string[] }) =>
      api.chatRooms.create(body),
    retry: false,
    onSuccess: () => invalidateRoomListAndGraph(qc),
  });
}

export function useJoinRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, sessionId }: { roomId: number; sessionId: string }) =>
      api.chatRooms.join(roomId, sessionId),
    retry: false,
    onSuccess: () => invalidateRoomListAndGraph(qc),
  });
}

export function useLeaveRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.chatRooms.leave(sessionId),
    retry: false,
    onSuccess: () => invalidateRoomListAndGraph(qc),
  });
}

export function useDeleteRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roomId: number) => api.chatRooms.delete(roomId),
    retry: false,
    onSuccess: () => invalidateRoomListAndGraph(qc),
  });
}

export interface RoomSummonInput {
  roomId: number;
  executorSessionId: string;
  prompt: string;
  senderIdentity?: string;
}

export function useRoomSummon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, executorSessionId, prompt, senderIdentity }: RoomSummonInput) =>
      api.chatRooms.summon(roomId, executorSessionId, prompt, senderIdentity),
    retry: false,
    onSuccess: (_data, vars) => invalidateRoomThread(qc, vars.roomId),
  });
}

export interface RoomBroadcastInput {
  roomId: number;
  prompt: string;
  senderIdentity?: string;
}

export function useRoomBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, prompt, senderIdentity }: RoomBroadcastInput) =>
      api.chatRooms.broadcast(roomId, prompt, senderIdentity),
    retry: false,
    onSuccess: (_data, vars) => invalidateRoomThread(qc, vars.roomId),
  });
}
