import { useState } from "react";
import type { AgentThread, ManagedDeliveryMode } from "@conflux/shared";
import { Megaphone, Send, Terminal, UserPlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useRoomDetail } from "../hooks";
import { ApprovalCard, type ResolveApprovalParams } from "./ApprovalCard";
import { MarkdownText } from "./MarkdownText";
import { RuntimeGlyph } from "./brand-icons";

interface RoomViewProps {
  roomId: number;
  allThreads: AgentThread[];
  onSelectThread: (threadId: string) => void;
  onResolveApproval: (params: ResolveApprovalParams) => Promise<unknown> | void;
}

export function RoomView({
  roomId,
  allThreads,
  onSelectThread,
  onResolveApproval,
}: RoomViewProps) {
  const qc = useQueryClient();
  const detailQuery = useRoomDetail(roomId);
  const [targetId, setTargetId] = useState<string>("__broadcast__");
  const [deliveryMode, setDeliveryMode] = useState<ManagedDeliveryMode>("queue");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinThreadId, setJoinThreadId] = useState("");

  if (detailQuery.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-xs text-ink-faint">
        加载协作房间...
      </div>
    );
  }

  const data = detailQuery.data;
  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-xs text-danger">
        房间不存在
      </div>
    );
  }

  const { room, tasks, messages, pending_approvals: pendingApprovals } = data;
  const threadById = new Map(allThreads.map((t) => [t.id, t]));
  const members = room.members
    .map((id) => threadById.get(id))
    .filter((t): t is AgentThread => Boolean(t));
  const nonMembers = allThreads.filter((t) => !room.members.includes(t.id));

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["room-detail", roomId] });
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
  };

  const handleJoin = async () => {
    if (!joinThreadId) return;
    await api.joinRoom(roomId, joinThreadId);
    setJoinThreadId("");
    invalidate();
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      if (targetId === "__broadcast__") {
        await api.broadcastRoom(roomId, trimmed);
      } else {
        await api.summonRoom(roomId, {
          executor_thread_id: targetId,
          prompt: trimmed,
          delivery_mode: deliveryMode,
        });
      }
      setPrompt("");
      invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="room-view" className="flex min-w-0 flex-1 flex-col bg-surface">
      {/* Compact member strip directly under TopBar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {members.length === 0 ? (
            <span className="text-xs text-ink-faint">尚未拉入成员</span>
          ) : (
            members.map((m) => (
              <button
                key={m.id}
                type="button"
                data-testid={`room-member-${m.id}`}
                onClick={() => onSelectThread(m.id)}
                className="inline-flex h-6 items-center gap-1.5 rounded-md bg-tile px-2 text-xs text-ink hover:bg-tile-hover transition-colors"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    m.state === "running"
                      ? "bg-accent animate-pulse"
                      : m.state === "waiting_approval"
                        ? "bg-warning animate-pulse"
                        : m.state === "idle"
                          ? "bg-success"
                          : "bg-neutral"
                  }`}
                />
                <RuntimeGlyph runtime={m.runtime} size={12} />
                <span>{m.name}</span>
                {m.kind === "external" && <Terminal className="h-3 w-3 text-info" />}
              </button>
            ))
          )}
        </div>

        {nonMembers.length > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              value={joinThreadId}
              onChange={(e) => setJoinThreadId(e.target.value)}
              className="h-7 rounded-md border border-line bg-paper/60 px-2 text-2xs text-ink"
            >
              <option value="">拉入成员...</option>
              {nonMembers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.runtime})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!joinThreadId}
              onClick={() => void handleJoin()}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-tile px-2 text-2xs font-medium text-ink hover:bg-tile-hover disabled:opacity-40"
            >
              <UserPlus className="h-3 w-3" />
              加入
            </button>
          </div>
        )}
      </div>

      {/* Main message feed */}
      <div className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-[760px] space-y-5">
          {pendingApprovals.length > 0 && (
            <div data-testid="room-pending-approvals" className="space-y-2">
              <div className="text-2xs font-medium text-warning">
                房间待审批（{pendingApprovals.length}）
              </div>
              {pendingApprovals.map((ap) => (
                <ApprovalCard
                  key={ap.id}
                  approval={ap}
                  onResolve={onResolveApproval}
                  onJumpToThread={onSelectThread}
                />
              ))}
            </div>
          )}

          {tasks.length > 0 && (
            <div className="divide-y divide-line border-y border-line py-1">
              {tasks.slice(0, 6).map((task) => {
                const exec = threadById.get(task.executor_thread_id);
                return (
                  <div key={task.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectThread(task.executor_thread_id)}
                        className="shrink-0 font-medium text-accent hover:underline"
                      >
                        @{exec?.name ?? task.executor_thread_id}
                      </button>
                      <span className="truncate text-ink-muted">{task.prompt}</span>
                    </div>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-2xs ${
                        task.status === "running"
                          ? "bg-accent-soft text-accent"
                          : task.status === "done"
                            ? "bg-success-soft text-success"
                            : task.status === "failed"
                              ? "bg-danger-soft text-danger"
                              : "bg-neutral-soft text-neutral"
                      }`}
                    >
                      {task.status}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {messages.length === 0 ? (
            <div className="py-16 text-center text-xs text-ink-faint">
              选择 <span className="font-mono text-ink">@成员</span> 或全员广播发起协作；执行细节留在各自工作台，最终结果自动回贴。
            </div>
          ) : (
            <div className="divide-y divide-line">
              {messages.map((msg) => (
                <div key={msg.id} className="space-y-2 py-4 first:pt-0">
                  <div className="flex items-center justify-between text-2xs text-ink-faint">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink">
                        {msg.from_name ?? msg.from_session}
                      </span>
                      <span>→</span>
                      <button
                        type="button"
                        onClick={() => onSelectThread(msg.to_session)}
                        className="font-medium text-accent hover:underline"
                      >
                        @{msg.to_name ?? msg.to_session}
                      </button>
                    </div>
                    <span className="font-mono">{msg.status}</span>
                  </div>
                  <div className="rounded-lg bg-tile px-3.5 py-2.5 text-ink">
                    <MarkdownText>{msg.question}</MarkdownText>
                  </div>
                  {msg.reply && (
                    <div className="border-l-2 border-success/50 pl-3.5 text-ink">
                      <div className="mb-1 text-2xs font-medium text-success">
                        @{msg.to_name ?? msg.to_session}
                      </div>
                      <MarkdownText>{msg.reply}</MarkdownText>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Minimalist Room Composer */}
      <form onSubmit={(e) => void handleSend(e)} className="shrink-0 px-5 pb-4 pt-2">
        <div className="mx-auto max-w-[760px] rounded-xl border border-line-strong bg-paper/50 p-2 focus-within:border-accent focus-within:bg-surface transition-colors">
          <div className="room-composer-row flex items-center gap-2">
            <input
              type="text"
              data-testid="room-composer-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入给房间成员的协作指令..."
              className="flex-1 bg-transparent px-1.5 py-1 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <button
              type="submit"
              disabled={sending || !prompt.trim()}
              data-testid="room-send-btn"
              className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-40"
            >
              {targetId === "__broadcast__" ? (
                <Megaphone className="h-3 w-3" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              发送
            </button>
          </div>
          <div className="room-composer-meta mt-1.5 flex items-center gap-2 border-t border-line/70 pt-1.5">
            <select
              data-testid="room-target-select"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="rounded bg-transparent px-1 py-0.5 text-2xs text-ink-muted focus:text-ink focus:outline-none"
            >
              <option value="__broadcast__">全员广播 ({members.length})</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  @{m.name} ({m.runtime})
                </option>
              ))}
            </select>
            {targetId !== "__broadcast__" && (
              <select
                value={deliveryMode}
                onChange={(e) => setDeliveryMode(e.target.value as ManagedDeliveryMode)}
                className="rounded bg-transparent px-1 py-0.5 text-2xs text-ink-muted focus:text-ink focus:outline-none"
              >
                <option value="queue">Queue</option>
                <option value="steer">Steer</option>
                <option value="interrupt">Interrupt</option>
              </select>
            )}
            {error && <span className="text-2xs text-danger">{error}</span>}
          </div>
        </div>
      </form>
    </div>
  );
}
