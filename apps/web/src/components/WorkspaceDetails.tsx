import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import { useDeleteRoom, useJoinRoom, useLeaveRoom, useRoomTasks } from "../room-hooks";
import type { ConversationTarget } from "../workspace-state";
import { DetailPanel } from "./DetailPanel";
import { StatusDot } from "./StatusDot";

export interface WorkspaceDetailsProps {
  target: ConversationTarget;
  rooms: readonly ChatRoom[];
  sessions: readonly GraphNode[];
  onClose: () => void;
  /** Fired after a successful delete so the owner can repair its selection. */
  onRoomDeleted: (roomId: number) => void;
  /** Open the peer conversation for a room member click. */
  onOpenSession: (sessionId: string) => void;
  /** Open an edge channel on the graph view (DetailPanel 发起对话). */
  onOpenGraphEdge: (edge: { id: number; from: string; to: string }) => void;
  /** A session node picked in the workspace graph — details only. */
  inspectedSession?: GraphNode | null;
  /** Explicit action that turns an inspection into a conversation. */
  onConverseWith?: (sessionId: string) => void;
  onClearInspection?: () => void;
}

/**
 * Details rail for the chat workspace. The room branch carries every
 * management action the old room cards had (add/remove member, delete
 * room, task overview); the session branch reuses the existing
 * DetailPanel so terminal/detail operations stay untouched.
 */
export function WorkspaceDetails({
  target,
  rooms,
  sessions,
  onClose,
  onRoomDeleted,
  onOpenSession,
  onOpenGraphEdge,
  inspectedSession,
  onConverseWith,
  onClearInspection,
}: WorkspaceDetailsProps) {
  if (inspectedSession) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="sticky top-0 z-10 bg-surface border-b border-line px-4 py-3 flex items-center gap-2">
          <span className="text-ink font-medium text-xs truncate">查看：{inspectedSession.name}</span>
          <button
            type="button"
            onClick={onClearInspection ?? onClose}
            className="ml-auto p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink flex-shrink-0"
            aria-label="返回目标详情"
          >
            <X size={13} />
          </button>
        </div>
        {/* selection is details-only: starting a conversation is explicit */}
        <div className="p-3 border-b border-line">
          <button
            type="button"
            onClick={() => onConverseWith?.(inspectedSession.id)}
            className="w-full py-2 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep"
          >
            与此会话对话
          </button>
        </div>
        <DetailPanel
          session={inspectedSession}
          message={null}
          edge={null}
          sessionNameLookup={(id) => sessions.find((s) => s.id === id)?.name}
          sessionStatusLookup={(id) => sessions.find((s) => s.id === id)?.status}
          onOpenEdge={onOpenGraphEdge}
        />
      </div>
    );
  }
  if (target?.kind === "room") {
    const room = rooms.find((r) => r.id === target.id);
    if (!room) {
      return (
        <div className="p-5 text-xs text-ink-faint">房间已不可用</div>
      );
    }
    return (
      <RoomDetails
        room={room}
        rooms={rooms}
        sessions={sessions}
        onClose={onClose}
        onRoomDeleted={onRoomDeleted}
        onOpenSession={onOpenSession}
      />
    );
  }

  if (target?.kind === "session") {
    const node = sessions.find((s) => s.id === target.id);
    if (!node) {
      return <div className="p-5 text-xs text-ink-faint">会话已不可用</div>;
    }
    return (
      <DetailPanel
        session={node}
        message={null}
        edge={null}
        sessionNameLookup={(id) => sessions.find((s) => s.id === id)?.name}
        sessionStatusLookup={(id) => sessions.find((s) => s.id === id)?.status}
        onOpenEdge={onOpenGraphEdge}
      />
    );
  }

  return <div className="p-5 text-xs text-ink-faint">选择一个对象查看详情</div>;
}

interface RoomDetailsProps {
  room: ChatRoom;
  rooms: readonly ChatRoom[];
  sessions: readonly GraphNode[];
  onClose: () => void;
  onRoomDeleted: (roomId: number) => void;
  onOpenSession: (sessionId: string) => void;
}

function RoomDetails({
  room,
  rooms,
  sessions,
  onClose,
  onRoomDeleted,
  onOpenSession,
}: RoomDetailsProps) {
  const tasksQuery = useRoomTasks(room.id, true);
  const join = useJoinRoom();
  const leave = useLeaveRoom();
  const remove = useDeleteRoom();

  const [adding, setAdding] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const members = room.members ?? [];
  // one room per session: candidates are sessions not in ANY room
  const roomedIds = useMemo(
    () => new Set(rooms.flatMap((r) => r.members ?? [])),
    [rooms],
  );
  const candidates = useMemo(
    () =>
      sessions.filter(
        (s) => s.type === "session" && s.id !== "web-console" && !roomedIds.has(s.id),
      ),
    [sessions, roomedIds],
  );

  const tasks = tasksQuery.data?.tasks ?? [];
  const done = tasks.filter((t) => t.status === "done").length;

  const memberName = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 bg-surface border-b border-line px-4 py-3 flex items-center gap-2">
        <Users size={13} className="text-accent" />
        <span className="text-ink font-medium text-xs truncate">{room.name}</span>
        <span className="text-2xs text-ink-faint">{members.length} 成员</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情面板"
          className="ml-auto p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink flex-shrink-0"
        >
          <X size={13} />
        </button>
      </div>

      <div className="p-4 space-y-5">
        {room.description && (
          <p className="text-2xs text-ink-muted">{room.description}</p>
        )}

        {/* members */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-2xs font-medium text-ink-faint">成员</h3>
            <button
              type="button"
              onClick={() => setAdding((v) => !v)}
              aria-expanded={adding}
              className="inline-flex items-center gap-1 text-2xs text-accent hover:text-accent-deep px-1.5 py-0.5 rounded"
            >
              <Plus size={11} /> 添加成员
            </button>
          </div>

          {adding && (
            <div className="mb-2 p-2 rounded-lg bg-tile max-h-44 overflow-y-auto space-y-0.5">
              {candidates.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={join.isPending}
                  onClick={() =>
                    join.mutate(
                      { roomId: room.id, sessionId: s.id },
                      { onSuccess: () => setAdding(false) },
                    )
                  }
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-tile-hover disabled:opacity-50"
                >
                  <StatusDot status={s.status} busy={s.busy} />
                  <span className="truncate">{s.name}</span>
                  <UserPlus size={11} className="ml-auto text-accent" />
                </button>
              ))}
              {candidates.length === 0 && (
                <div className="text-2xs text-ink-faint text-center py-2">
                  没有可拉入的会话（会话同时只能属于一个房间）
                </div>
              )}
            </div>
          )}
          {join.isError && (
            <div role="alert" className="text-2xs text-danger mb-2">
              添加失败：{(join.error as Error).message}
            </div>
          )}

          <div className="space-y-1">
            {members.map((mid) => {
              const session = sessions.find((s) => s.id === mid);
              return (
                <div key={mid} className="group flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-tile-hover">
                  <StatusDot status={session?.status ?? "stale"} busy={session?.busy} />
                  <button
                    type="button"
                    onClick={() => onOpenSession(mid)}
                    className="truncate flex-1 text-left hover:text-accent"
                    title="打开单聊"
                  >
                    {memberName(mid)}
                  </button>
                  {confirmingLeave === mid ? (
                    <span className="flex items-center gap-1 text-2xs">
                      <button
                        type="button"
                        onClick={() =>
                          leave.mutate(mid, {
                            onSuccess: () => setConfirmingLeave(null),
                          })
                        }
                        className="px-2 py-0.5 rounded-md bg-red-500 text-white"
                      >
                        确认移出
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingLeave(null)}
                        className="px-2 py-0.5 rounded-md border border-line text-ink-muted"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingLeave(mid)}
                      aria-label={`移出成员 ${memberName(mid)}`}
                      title="移出"
                      className="p-1 rounded text-ink-faint hover:text-red-500"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
            {members.length === 0 && (
              <div className="text-2xs text-ink-faint px-2 py-2">房间还没有成员</div>
            )}
            {members.filter((mid) => !sessions.some((s) => s.id === mid)).length > 0 && (
              <div className="text-2xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                {members.filter((mid) => !sessions.some((s) => s.id === mid)).length} 位成员暂无法加载（会话未出现在图谱中）
              </div>
            )}
          </div>
          {leave.isError && (
            <div role="alert" className="text-2xs text-danger mt-1">
              移出失败：{(leave.error as Error).message}
            </div>
          )}
        </section>

        {/* task overview */}
        <section>
          <h3 className="text-2xs font-medium text-ink-faint mb-2">任务概览</h3>
          {tasksQuery.isLoading ? (
            <div className="flex justify-center py-2">
              <Loader2 size={12} className="text-ink-faint animate-spin" />
            </div>
          ) : tasksQuery.isError ? (
            <div className="text-2xs text-danger">任务加载失败：{(tasksQuery.error as Error).message}</div>
          ) : (
            <div className="text-2xs text-ink-muted flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={11} className="text-emerald-500" /> {done} 完成
              </span>
              <span className="inline-flex items-center gap-1">
                <AlertCircle size={11} className="text-ink-faint" /> 共 {tasks.length} 个
              </span>
            </div>
          )}
        </section>

        {/* danger zone */}
        <section className="border-t border-line pt-4">
          {confirmingDelete ? (
            <div className="space-y-2">
              <p className="text-2xs text-danger">
                确认删除「{room.name}」？成员将被释放回未入房状态，消息与任务记录按现有删除语义处理。
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(room.id, {
                      onSuccess: () => {
                        setConfirmingDelete(false);
                        onRoomDeleted(room.id);
                      },
                    })
                  }
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-500 text-white text-2xs font-medium disabled:opacity-50"
                >
                  {remove.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="px-3 py-1.5 rounded-lg border border-line text-ink-muted text-2xs"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-2xs text-ink-faint hover:text-red-500 hover:border-red-300"
            >
              <Trash2 size={11} /> 删除房间
            </button>
          )}
          {remove.isError && (
            <div role="alert" className="text-2xs text-danger mt-2">
              删除失败：{(remove.error as Error).message}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
