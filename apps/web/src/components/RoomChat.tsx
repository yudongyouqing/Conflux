import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, Play, CheckCircle2, Circle, AlertCircle, UserPlus } from "lucide-react";
import type { ChatRoom, GraphNode } from "@conflux/shared";
import { useRoomBroadcast, useRoomMessages, useRoomSummon, useRoomTasks } from "../room-hooks";
import { targetKey, type Draft } from "../workspace-state";
import { MarkdownText } from "./MarkdownText";
import { StatusDot } from "./StatusDot";

const STATUS_ICON: Record<string, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: CheckCircle2,
  failed: AlertCircle,
};

const STATUS_COLOR: Record<string, string> = {
  pending: "text-ink-faint",
  running: "text-accent animate-pulse",
  done: "text-emerald-500",
  failed: "text-red-500",
};

export interface RoomChatProps {
  /** The real room object — its id routes every request. */
  room: ChatRoom;
  /** Member nodes resolved from the graph; empty rooms cannot send. */
  members: readonly GraphNode[];
  active: boolean;
  draft: Draft;
  onDraftChange: (text: string) => void;
  onSubmitted: (targetKey: string, revision: number) => void;
  /** Empty rooms point here instead of a disabled mystery. */
  onManageMembers: () => void;
  /**
   * Directed executor for THIS room, owned by the workspace so it survives
   * room switches alongside the draft (full session id; display names never
   * route). A stale id (member left) blocks sending instead of widening to
   * a broadcast until the user explicitly re-decides.
   */
  executorId: string | null;
  onExecutorChange: (id: string | null) => void;
}

/**
 * Room orchestration view: task timeline + broadcast thread + summon
 * composer. Data comes from the workspace room hooks; the composer is a
 * controlled draft so switching rooms/conversations never loses or crosses
 * text. Submits capture their own room id and draft revision — a slow or
 * late success can only clear the exact snapshot it sent.
 */
export function RoomChat({
  room,
  members,
  active,
  draft,
  onDraftChange,
  onSubmitted,
  onManageMembers,
  executorId,
  onExecutorChange,
}: RoomChatProps) {
  const tasksQuery = useRoomTasks(room.id, active);
  const threadQuery = useRoomMessages(room.id, active);
  const summon = useRoomSummon(onSubmitted);
  const broadcast = useRoomBroadcast(onSubmitted);

  const [senderIdentity, setSenderIdentity] = useState<string>("web-console");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // a directed target is valid only while the member is still in the room;
  // it is kept (and sending blocked) rather than silently dropped — falling
  // back to a broadcast would widen the audience without consent
  const executorMissing = executorId != null && !members.some((m) => m.id === executorId);

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);

  // @mention autocomplete: candidates come from THIS room only
  const mentionMatches =
    mentionQuery !== null
      ? members.filter((m) => {
          const q = mentionQuery.toLowerCase();
          return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
        })
      : [];

  const handleInputChange = (value: string) => {
    onDraftChange(value);
    const atIdx = value.lastIndexOf("@");
    if (atIdx >= 0 && !value.slice(atIdx + 1).includes(" ")) {
      setMentionQuery(value.slice(atIdx + 1));
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const pickMention = (member: GraphNode) => {
    const atIdx = draft.text.lastIndexOf("@");
    if (atIdx >= 0) {
      onDraftChange(`${draft.text.slice(0, atIdx)}@${member.name} `);
    }
    // the display text is decoration; the full session id is the target
    onExecutorChange(member.id);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pickMention(mentionMatches[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    // IME composition Enter confirms the candidate, it must not submit
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const send = () => {
    const text = draft.text.trim();
    if (!text || summon.isPending || broadcast.isPending) return;
    if (members.length === 0) return; // nobody to receive a broadcast
    if (executorMissing) return; // stale target: block, never widen
    // snapshot at submit time: these values, not a possibly-changed render.
    // key+revision ride inside the mutation so the draft clears even if
    // this component is gone when the response lands.
    const revision = draft.revision;
    const key = targetKey({ kind: "room", id: room.id });
    if (executorId) {
      summon.mutate({
        roomId: room.id,
        executorSessionId: executorId,
        prompt: text,
        senderIdentity,
        targetKey: key,
        revision,
      });
    } else {
      broadcast.mutate({ roomId: room.id, prompt: text, senderIdentity, targetKey: key, revision });
    }
  };

  const tasks = tasksQuery.data?.tasks ?? [];
  const thread = threadQuery.data?.messages ?? [];
  const sending = summon.isPending || broadcast.isPending;
  const sendError = (summon.error ?? broadcast.error) as Error | null;
  const noMembers = members.length === 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* task timeline + broadcast thread */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
        {tasksQuery.isLoading && tasks.length === 0 ? (
          <div className="flex justify-center py-8">
            <Loader2 size={16} className="text-ink-faint animate-spin" />
          </div>
        ) : tasksQuery.isError && tasks.length === 0 ? (
          <div role="alert" className="text-center py-8 space-y-2">
            <div className="text-xs text-danger">任务加载失败：{(tasksQuery.error as Error).message}</div>
            <button
              type="button"
              onClick={() => tasksQuery.refetch()}
              className="px-3 py-1.5 rounded-lg bg-accent-soft text-accent text-xs font-medium"
            >
              重试
            </button>
          </div>
        ) : tasks.length === 0 && thread.length === 0 ? (
          <div className="room-empty-state text-center py-12 text-ink-faint text-xs">
            <div>{noMembers ? "房间还没有成员" : "还没有任务"}</div>
            <div className="mt-1">
              {noMembers
                ? "先在详情里添加成员，才能广播或定向发送"
                : "在下方选择成员并输入任务，或直接广播给全员"}
            </div>
          </div>
        ) : (
          <>
            {tasks.map((task) => {
              const Icon = STATUS_ICON[task.status] ?? Circle;
              return (
                <div key={task.id} className="rounded-xl bg-surface p-4 shadow-sm space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Icon
                      size={13}
                      className={`${STATUS_COLOR[task.status]} ${task.status === "running" ? "animate-spin" : ""}`}
                    />
                    <span className="font-medium text-ink">{nameOf(task.initiator_session_id)}</span>
                    <span className="text-ink-faint">→</span>
                    <span className="font-medium text-ink">{nameOf(task.executor_session_id)}</span>
                    <span className="text-2xs text-ink-faint ml-auto">#{task.id}</span>
                  </div>
                  <div className="text-xs text-ink-muted bg-tile rounded-lg px-3 py-2">
                    <MarkdownText tone="light">{task.prompt}</MarkdownText>
                  </div>
                  {task.result && (
                    <div className="text-xs text-ink bg-accent-soft rounded-lg px-3 py-2 border-l-2 border-accent">
                      <div className="text-2xs text-accent font-medium mb-1">
                        {nameOf(task.executor_session_id)} 的结果：
                      </div>
                      <MarkdownText tone="light">{task.result}</MarkdownText>
                    </div>
                  )}
                </div>
              );
            })}

            {thread.length > 0 && (
              <div className="pt-2">
                <div className="text-2xs text-ink-faint mb-2">广播讨论</div>
                <div className="space-y-3">
                  {thread.map((m) => (
                    <div key={m.id} className="rounded-xl bg-surface p-3 shadow-sm space-y-1.5">
                      <div className="text-2xs text-ink-faint">
                        {m.from_name} → {m.to_name} · #{m.id}
                      </div>
                      <div className="text-xs text-ink-muted">{m.question}</div>
                      {m.reply && (
                        <div className="text-xs text-ink bg-accent-soft rounded-lg px-3 py-2 border-l-2 border-accent">
                          {m.reply}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {threadQuery.isError && thread.length > 0 && (
          <div className="text-2xs text-amber-700 text-center">连接中断，显示上次获取的内容</div>
        )}
      </div>

      {/* composer */}
      <div className="border-t border-line px-4 py-3 space-y-2 flex-shrink-0 relative room-composer">
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 rounded-xl bg-surface border border-line shadow-raised overflow-hidden z-10 max-h-40 overflow-y-auto">
            {mentionMatches.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pickMention(m)}
                onMouseEnter={() => setMentionIndex(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                  i === mentionIndex ? "bg-accent-soft text-accent" : "text-ink hover:bg-tile-hover"
                }`}
              >
                <StatusDot status={m.status} busy={m.busy} />
                <span className="font-medium">{m.name}</span>
                <span className="text-ink-faint text-2xs ml-auto">{m.id.slice(0, 12)}</span>
              </button>
            ))}
          </div>
        )}

        {noMembers ? (
          <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span>房间没有成员，暂无法发送</span>
            <button
              type="button"
              onClick={onManageMembers}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-soft text-accent font-medium"
            >
              <UserPlus size={12} /> 添加成员
            </button>
          </div>
        ) : (
          <>
            <div className="room-composer-meta flex items-center gap-2 text-2xs">
              <span className="text-ink-faint">发起方</span>
              <select
                aria-label="发起方身份"
                value={senderIdentity}
                onChange={(e) => setSenderIdentity(e.target.value)}
                className="px-2 py-1 rounded-lg border border-line text-2xs text-ink bg-surface focus:border-accent outline-none"
              >
                <option value="web-console">👤 Web 控制台</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    🤖 {m.name}
                  </option>
                ))}
              </select>
              {executorId ? (
                executorMissing ? (
                  <>
                    <span className="text-danger font-medium" role="alert">
                      目标成员已不在房间，请重新选择
                    </span>
                    <button
                      type="button"
                      onClick={() => onExecutorChange(null)}
                      className="text-ink-faint hover:text-ink underline"
                      title="清除目标，改为广播"
                    >
                      清除目标
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-ink-faint">→</span>
                    <span className="text-accent font-medium">{nameOf(executorId)}</span>
                    <button
                      type="button"
                      onClick={() => onExecutorChange(null)}
                      className="text-ink-faint hover:text-ink"
                      title="清除目标"
                    >
                      ×
                    </button>
                  </>
                )
              ) : (
                <span className="text-ink-faint">发送给当前房间全部成员</span>
              )}
            </div>

            <div className="room-composer-row flex items-center gap-2">
              <input
                ref={inputRef}
                aria-label="任务输入"
                value={draft.text}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="@某成员 下发任务，或不 @ 广播…"
                className="flex-1 px-3.5 py-2.5 rounded-xl border border-line text-xs text-ink bg-surface placeholder-ink-faint focus:border-accent outline-none"
              />
              <button
                type="button"
                onClick={send}
                disabled={!draft.text.trim() || sending || executorMissing}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                {executorId ? "召唤" : "广播"}
              </button>
            </div>

            {sendError && (
              <div role="alert" className="text-xs text-danger">
                发送失败：{sendError.message}。草稿已保留，请核对记录后重试
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
