import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, Send, Loader2, ArrowRight } from "lucide-react";
import type { GraphNode, Message } from "@conflux/shared";
import { api } from "../api";
import { StatusDot } from "./StatusDot";
import { MarkdownText } from "./MarkdownText";

interface RoomChatProps {
  roomName: string;
  members: GraphNode[];
  onBack: () => void;
  /** the acting session (who sends questions) — web console by default */
  selfId?: string;
}

/**
 * Room conversation view (#137): pick a member, ask them a question, see the
 * full message history between room members. This is the "chat" part of
 * "chat room" — not just member management, but actual communication.
 */
export function RoomChat({ roomName, members, onBack, selfId = "web-console" }: RoomChatProps) {
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);

  const fetchMessages = useCallback(async (peerId: string) => {
    if (!peerId) return;
    try {
      const r = await api.getMessages({ from: selfId, to: peerId, status: "all" });
      const r2 = await api.getMessages({ from: peerId, to: selfId, status: "all" });
      const all = [...(r.messages ?? []), ...(r2.messages ?? [])].sort(
        (a, b) => a.created_at.localeCompare(b.created_at),
      );
      setMessages(all);
    } catch {
      // server not reachable — show what we have
    }
  }, [selfId]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetchMessages(selected.id).finally(() => setLoading(false));
    // poll for new messages every 3s
    pollRef.current = setInterval(() => fetchMessages(selected.id), 3_000);
    return () => clearInterval(pollRef.current);
  }, [selected, fetchMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    setInput("");
    try {
      await api.webAsk({ to_session: selected.id, question: text, from_session: selfId });
      await fetchMessages(selected.id);
    } catch {
      // message still delivered server-side; next poll will pick it up
    } finally {
      setSending(false);
    }
  };

  // member picker
  if (!selected) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
          <button onClick={onBack} className="p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink">
            <ArrowLeft size={16} />
          </button>
          <span className="text-ink font-medium text-sm">{roomName}</span>
          <span className="text-2xs text-ink-faint">· 选择要对话的成员</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {members.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-surface hover:bg-tile-hover transition-colors text-left"
            >
              <StatusDot status={m.status} busy={m.busy} />
              <div className="flex-1 min-w-0">
                <div className="text-ink text-sm font-medium truncate">{m.name}</div>
                {m.description && (
                  <div className="text-2xs text-ink-faint truncate mt-0.5">{m.description}</div>
                )}
              </div>
              <ArrowRight size={14} className="text-ink-faint" />
            </button>
          ))}
          {members.length === 0 && (
            <div className="text-center py-12 text-ink-faint text-xs">
              还没有成员——回到房间管理拉人进来
            </div>
          )}
        </div>
      </div>
    );
  }

  // conversation view
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
        <button
          onClick={() => setSelected(null)}
          className="p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink"
        >
          <ArrowLeft size={16} />
        </button>
        <StatusDot status={selected.status} busy={selected.busy} />
        <div className="flex-1 min-w-0">
          <div className="text-ink font-medium text-sm truncate">{selected.name}</div>
          <div className="text-2xs text-ink-faint">
            {roomName} · {selected.status === "active" ? (selected.busy ? "正在回复中" : "在线") : "离线（发送后将自动唤醒）"}
          </div>
        </div>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {loading && messages.length === 0 ? (
          <div className="flex justify-center py-8">
            <Loader2 size={16} className="text-ink-faint animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-ink-faint text-xs">还没有对话</div>
        ) : (
          messages.map((msg) => {
            const isMine = msg.from_session === selfId;
            return (
              <div key={msg.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] px-3.5 py-2.5 rounded-xl text-xs ${
                    isMine
                      ? "bg-accent text-white"
                      : "bg-surface text-ink"
                  }`}
                >
                  <div className="mb-1">
                    <span className={`text-2xs ${isMine ? "text-white/60" : "text-ink-faint"}`}>
                      {nameOf(msg.from_session)} → {nameOf(msg.to_session)}
                    </span>
                  </div>
                  <MarkdownText tone={isMine ? "blue" : "light"}>{msg.question}</MarkdownText>
                  {msg.reply && (
                    <div className="mt-2 pt-2 border-t border-white/10">
                      <span className={`text-2xs ${isMine ? "text-white/60" : "text-ink-faint"}`}>
                        ↩ {nameOf(msg.to_session)} 回复：
                      </span>
                      <MarkdownText tone={isMine ? "blue" : "light"}>{msg.reply}</MarkdownText>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-line flex-shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder={`向 ${selected.name} 提问…`}
          className="flex-1 px-3.5 py-2.5 rounded-xl border border-line text-xs text-ink bg-surface placeholder-ink-faint focus:border-accent outline-none"
        />
        <button
          onClick={send}
          disabled={!input.trim() || sending}
          className="p-2.5 rounded-xl bg-accent text-white hover:bg-accent-deep disabled:opacity-40"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
