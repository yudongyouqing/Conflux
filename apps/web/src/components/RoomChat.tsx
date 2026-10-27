import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, Loader2, Play, CheckCircle2, Circle, AlertCircle, Users } from "lucide-react";
import type { GraphNode } from "@conflux/shared";
import { api } from "../api";
import { MarkdownText } from "./MarkdownText";

interface RoomTask {
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

interface RoomChatProps {
  roomId: number;
  roomName: string;
  members: GraphNode[];
  onBack: () => void;
}

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

/**
 * Room orchestration view (#152): task timeline + summon controls.
 * Shows agent tasks (prompt → result), their status, and lets the human
 * initiate new tasks by selecting an executor + typing a prompt.
 */
export function RoomChat({ roomId, roomName, members, onBack }: RoomChatProps) {
  const [tasks, setTasks] = useState<RoomTask[]>([]);
  const [thread, setThread] = useState<Array<{
    id: number; from_name: string; to_name: string; question: string;
    reply: string | null; created_at: string;
  }>>([]);
  const [senderIdentity, setSenderIdentity] = useState<string>("web-console");
  const [selectedExecutor, setSelectedExecutor] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const inputRef = useRef<HTMLInputElement>(null);

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);

  // @mention autocomplete: filter members by current query after '@'
  const mentionMatches = mentionQuery !== null
    ? members.filter((m) =>
        m.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
        m.id.toLowerCase().includes(mentionQuery.toLowerCase()),
      )
    : [];

  const handleInputChange = (value: string) => {
    setPrompt(value);
    // detect @mention trigger: last '@' with no space after it
    const atIdx = value.lastIndexOf("@");
    if (atIdx >= 0 && !value.slice(atIdx + 1).includes(" ")) {
      setMentionQuery(value.slice(atIdx + 1));
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const pickMention = (member: GraphNode) => {
    const atIdx = prompt.lastIndexOf("@");
    if (atIdx >= 0) {
      const before = prompt.slice(0, atIdx);
      setPrompt(`${before}@${member.name} `);
      setSelectedExecutor(member.id);
    }
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // mention picker navigation
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && mentionMatches.length === 1)) {
        e.preventDefault(); pickMention(mentionMatches[mentionIndex]); return;
      }
      if (e.key === "Escape") { setMentionQuery(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) send();
  };

  const fetchTasks = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([
        api.chatRooms.orchestrate(roomId),
        api.chatRooms.messages(roomId),
      ]);
      setTasks(r.tasks);
      setThread(t.messages);
    } catch { /* server unreachable */ }
  }, [roomId]);

  useEffect(() => {
    setLoading(true);
    fetchTasks().finally(() => setLoading(false));
    pollRef.current = setInterval(fetchTasks, 3_000);
    return () => clearInterval(pollRef.current);
  }, [fetchTasks]);

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    setPrompt("");
    try {
      // @target = 定向任务（#152）；不 @ = 广播，全员自选回答（#151）
      if (selectedExecutor) {
        await api.chatRooms.summon(roomId, selectedExecutor, text, senderIdentity);
      } else {
        await api.chatRooms.broadcast(roomId, text, senderIdentity);
      }
      await fetchTasks();
    } catch { /* next poll will pick up */ }
    finally { setSending(false); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="room-chat-header flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
        <button onClick={onBack} className="p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink">
          <ArrowLeft size={16} />
        </button>
        <Users size={14} className="text-accent" />
        <span className="text-ink font-medium text-sm">{roomName}</span>
        <span className="text-2xs text-ink-faint">
          {tasks.filter(t => t.status === "done").length}/{tasks.length} 完成
        </span>
      </div>

      {/* task timeline */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
        {loading && tasks.length === 0 ? (
          <div className="flex justify-center py-8">
            <Loader2 size={16} className="text-ink-faint animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="room-empty-state text-center py-12 text-ink-faint text-xs">
            <div>还没有任务</div>
            <div className="mt-1">在下方选择 Agent 并输入任务，或直接广播给全员</div>
            <button
              type="button"
              onClick={() => inputRef.current?.focus()}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent-soft text-accent font-medium hover:bg-accent-soft"
            >
              <Play size={12} /> 开始下发任务
            </button>
          </div>
        ) : (
          tasks.map((task) => {
            const Icon = STATUS_ICON[task.status] ?? Circle;
            return (
              <div key={task.id} className="rounded-xl bg-surface p-4 shadow-sm space-y-2">
                {/* task header */}
                <div className="flex items-center gap-2 text-xs">
                  <Icon size={13} className={`${STATUS_COLOR[task.status]} ${task.status === "running" ? "animate-spin" : ""}`} />
                  <span className="font-medium text-ink">{nameOf(task.initiator_session_id)}</span>
                  <span className="text-ink-faint">→</span>
                  <span className="font-medium text-ink">{nameOf(task.executor_session_id)}</span>
                  <span className="text-2xs text-ink-faint ml-auto">#{task.id}</span>
                </div>

                {/* prompt */}
                <div className="text-xs text-ink-muted bg-tile rounded-lg px-3 py-2">
                  <MarkdownText tone="light">{task.prompt}</MarkdownText>
                </div>

                {/* result */}
                {task.result && (
                  <div className="text-xs text-ink bg-accent-soft rounded-lg px-3 py-2 border-l-2 border-accent">
                    <div className="text-2xs text-accent font-medium mb-1">{nameOf(task.executor_session_id)} 的结果：</div>
                    <MarkdownText tone="light">{task.result}</MarkdownText>
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* broadcast shared thread (#151): questions + self-selected replies */}
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
      </div>

      {/* summon input with sender identity + @mention target */}
      <div className="border-t border-line px-4 py-3 space-y-2 flex-shrink-0 relative room-composer">
        {/* @mention autocomplete popup */}
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 rounded-xl bg-surface border border-line shadow-raised overflow-hidden z-10 max-h-40 overflow-y-auto">
            {mentionMatches.map((m, i) => (
              <button
                key={m.id}
                onClick={() => pickMention(m)}
                onMouseEnter={() => setMentionIndex(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                  i === mentionIndex ? "bg-accent-soft text-accent" : "text-ink hover:bg-tile-hover"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${m.status === "active" ? "bg-emerald-500" : "bg-ink-faint/50"}`} />
                <span className="font-medium">{m.name}</span>
                <span className="text-ink-faint text-2xs ml-auto">{m.id.slice(0, 8)}</span>
              </button>
            ))}
          </div>
        )}

        {/* row 1: sender identity (who am I) + executor target (who runs it) */}
        <div className="room-composer-meta flex items-center gap-2 text-2xs">
          <span className="text-ink-faint">发起方</span>
          <select
            value={senderIdentity}
            onChange={(e) => setSenderIdentity(e.target.value)}
            className="px-2 py-1 rounded-lg border border-line text-2xs text-ink bg-surface focus:border-accent outline-none"
          >
            <option value="web-console">👤 Web 控制台</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>🤖 {m.name}</option>
            ))}
          </select>
          {selectedExecutor && (
            <>
              <span className="text-ink-faint">→</span>
              <span className="text-accent font-medium">{nameOf(selectedExecutor)}</span>
              <button
                onClick={() => setSelectedExecutor("")}
                className="text-ink-faint hover:text-ink"
                title="清除目标"
              >
                ×
              </button>
            </>
          )}
          {!selectedExecutor && (
            <span className="text-ink-faint">@某人定向，不 @ 则广播</span>
          )}
        </div>

        {/* row 2: prompt input */}
        <div className="room-composer-row flex items-center gap-2">
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`@某Agent 下发任务，或不 @ 广播…`}
            className="flex-1 px-3.5 py-2.5 rounded-xl border border-line text-xs text-ink bg-surface placeholder-ink-faint focus:border-accent outline-none"
          />
          <button
            onClick={send}
            disabled={!prompt.trim() || sending}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-accent text-white text-xs font-medium hover:bg-accent-deep disabled:opacity-40"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {selectedExecutor ? "召唤" : "广播"}
          </button>
        </div>
      </div>
    </div>
  );
}
