import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, Play, CheckCircle2, Circle, AlertCircle, UserPlus } from "lucide-react";
import { WEB_CONSOLE_ID, type ChatRoom, type GraphNode } from "@conflux/shared";
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
  running: "text-accent",
  done: "text-success",
  failed: "text-danger",
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

  const [senderIdentity, setSenderIdentity] = useState<string>(WEB_CONSOLE_ID);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // If the chosen sender member leaves the room, reset to web-console so the
  // submitted identity matches what the <select> displays.
  useEffect(() => {
    if (senderIdentity !== WEB_CONSOLE_ID && !members.some((m) => m.id === senderIdentity)) {
      setSenderIdentity(WEB_CONSOLE_ID);
    }
  }, [members, senderIdentity]);

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

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition Enter confirms the candidate — never hijack it for mentions or submit.
    if (e.nativeEvent.isComposing) return;
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
        const picked = mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)];
        if (picked) pickMention(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
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
    <div className="flex flex-col h-full min-h-0 bg-surface">
      {/* task timeline + broadcast thread */}
      <div className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
        <div className="max-w-3xl mx-auto space-y-4">
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
        ) : threadQuery.isError && tasks.length === 0 && thread.length === 0 ? (
          <div role="alert" className="text-center py-8 space-y-2">
            <div className="text-xs text-danger">广播记录加载失败：{(threadQuery.error as Error).message}</div>
            <button
              type="button"
              onClick={() => threadQuery.refetch()}
              className="px-3 py-1.5 rounded-lg bg-accent-soft text-accent text-xs font-medium"
            >
              重试
            </button>
          </div>
        ) : tasks.length === 0 && thread.length === 0 ? (
          <div className="text-center py-16 text-ink-faint text-xs">
            <div className="text-sm font-medium text-ink-muted">
              {noMembers ? "房间还没有成员" : "还没有任务或讨论"}
            </div>
            <div className="mt-1.5">
              {noMembers
                ? "先在右侧详情添加成员，才能广播或定向发送"
                : "在下方输入 @成员 定向派发任务，或直接发送广播给全员"}
            </div>
          </div>
        ) : (
          <>
            {tasks.map((task) => {
              const Icon = STATUS_ICON[task.status] ?? Circle;
              return (
                <div
                  key={task.id}
                  className="rounded-xl border border-line/80 bg-paper/50 p-4 space-y-2.5"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <Icon
                      size={13}
                      className={`${STATUS_COLOR[task.status]} ${task.status === "running" ? "animate-spin" : ""}`}
                    />
                    <span className="font-medium text-ink">{nameOf(task.initiator_session_id)}</span>
                    <span className="text-ink-faint">→</span>
                    <span className="font-medium text-ink">{nameOf(task.executor_session_id)}</span>
                    <span className="text-2xs font-mono text-ink-faint tabular-nums ml-auto">
                      #{task.id}
                    </span>
                  </div>
                  <div className="text-md-plus text-ink-muted bg-surface border border-line/70 rounded-lg px-3.5 py-2.5 leading-relaxed">
                    <MarkdownText tone="light">{task.prompt}</MarkdownText>
                  </div>
                  {task.result && (
                    <div className="text-md-plus text-ink bg-accent-soft/70 rounded-lg px-3.5 py-2.5 border-l-2 border-accent leading-relaxed">
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
              <div className="pt-3 border-t border-line/70">
                <div className="text-2xs font-medium text-ink-faint mb-2.5">广播讨论</div>
                <div className="space-y-3">
                  {thread.map((m) => (
                    <div
                      key={m.id}
                      className="rounded-xl border border-line/80 bg-paper/50 p-3.5 space-y-2"
                    >
                      <div className="flex items-center gap-1.5 text-2xs text-ink-faint">
                        <span className="font-medium text-ink">{m.from_name}</span>
                        <span>→</span>
                        <span className="font-medium text-ink">{m.to_name}</span>
                        <span className="font-mono tabular-nums ml-auto">#{m.id}</span>
                      </div>
                      <div className="text-md-plus text-ink-muted leading-relaxed">{m.question}</div>
                      {m.reply && (
                        <div className="text-md-plus text-ink bg-accent-soft/70 rounded-lg px-3.5 py-2 border-l-2 border-accent leading-relaxed">
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
          <div className="text-2xs text-warning text-center">连接中断，显示上次获取的内容</div>
        )}
        </div>
      </div>

      {/* Linear-style floating docked composer */}
      <div className="px-4 pb-4 pt-2 flex-shrink-0 relative room-composer">
        <div className="max-w-3xl mx-auto relative">
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl bg-surface border border-line shadow-raised overflow-hidden z-10 max-h-44 overflow-y-auto">
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
                <span className="text-ink-faint font-mono text-2xs ml-auto">{m.id.slice(0, 12)}</span>
              </button>
            ))}
          </div>
        )}

        {noMembers ? (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-paper/60 px-3.5 py-2.5 text-xs text-ink-faint">
            <span>房间没有成员，暂无法发送</span>
            <button
              type="button"
              onClick={onManageMembers}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-soft text-accent font-medium hover:opacity-90"
            >
              <UserPlus size={12} /> 添加成员
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-surface shadow-card focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 transition-all">
            <div className="room-composer-row px-3.5 pt-2.5 pb-1.5">
              <textarea
                ref={inputRef}
                aria-label="任务输入"
                rows={2}
                value={draft.text}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="@某成员 下发任务，或不 @ 广播…（Enter 发送，Shift+Enter 换行）"
                className="w-full text-md-plus text-ink bg-transparent placeholder-ink-faint outline-none resize-none leading-relaxed"
                style={{ maxHeight: "140px" }}
              />
            </div>

            <div className="room-composer-meta flex items-center gap-2 px-3 py-2 border-t border-line/60 text-2xs">
              <span className="text-ink-faint">发起方</span>
              <select
                aria-label="发起方身份"
                value={senderIdentity}
                onChange={(e) => setSenderIdentity(e.target.value)}
                className="px-2 py-1 rounded-md border border-line/80 text-2xs text-ink bg-paper/60 focus:border-accent outline-none"
              >
                <option value={WEB_CONSOLE_ID}>Web 控制台</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
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
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-soft text-accent font-medium">
                    <span>@{nameOf(executorId)}</span>
                    <button
                      type="button"
                      onClick={() => onExecutorChange(null)}
                      className="text-accent/70 hover:text-accent ml-0.5"
                      title="清除目标"
                    >
                      ×
                    </button>
                  </span>
                )
              ) : (
                <span className="text-ink-faint hidden sm:inline">发送给当前房间全部成员</span>
              )}
              <button
                type="button"
                onClick={send}
                disabled={!draft.text.trim() || sending || executorMissing}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-40 transition-colors"
              >
                {sending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={12} />
                )}
                {executorId ? "召唤" : "广播"}
              </button>
            </div>
          </div>
        )}

        {sendError && (
          <div role="alert" className="text-xs text-danger mt-1.5 px-1">
            发送失败：{sendError.message}。草稿已保留，请核对记录后重试
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
