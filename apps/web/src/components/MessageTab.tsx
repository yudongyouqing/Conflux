import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMessages, useGraph, useSessions, usePeerMessages } from "../hooks";
import { api } from "../api";
import { MentionComposer } from "./MentionComposer";
import { MessageCard } from "./MessageCard";
import { MarkdownText } from "./MarkdownText";
import { StatusDot } from "./StatusDot";
import { ArrowLeft, Send } from "lucide-react";
import { WEB_CONSOLE_ID, type Message } from "@conflux/shared";

interface MessageTabProps {
  onSelectMessage: (msg: Message | null) => void;
  selectedMessageId: number | null;
}

/** Message feed with full-height thread view: clicking a message (or sending
 * one) swaps the whole tab to the conversation with that peer — bubbles at
 * full height plus a fixed-target composer — instead of the old cramped
 * max-h-48 box. A back button returns to the feed. */
export function MessageTab({ onSelectMessage, selectedMessageId }: MessageTabProps) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [peer, setPeer] = useState<string | null>(null); // thread open with this session
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useMessages({ status: statusFilter });
  const graph = useGraph();
  const sessions = useSessions("active");
  const thread = usePeerMessages(peer);

  const queryClient = useQueryClient();
  const ask = useMutation({
    mutationFn: (question: string) => api.webAsk({ to_session: peer!, question }),
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["peer-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const { nameMap, statusMap } = useMemo(() => {
    const names = new Map<string, string>();
    const statuses = new Map<string, string>();
    graph.data?.nodes.forEach((n) => {
      names.set(n.id, n.name);
      statuses.set(n.id, n.status);
    });
    return { nameMap: names, statusMap: statuses };
  }, [graph.data]);

  const messages = data?.messages ?? [];

  const filtered = useMemo(
    () =>
      search
        ? messages.filter(
            (m) =>
              m.question.toLowerCase().includes(search.toLowerCase()) ||
              (m.reply?.toLowerCase().includes(search.toLowerCase()) ?? false),
          )
        : messages,
    [messages, search],
  );

  const peerSession = sessions.data?.sessions.find((s) => s.id === peer);
  const peerName = peer
    ? (peerSession?.name ?? nameMap.get(peer) ?? peer.slice(0, 8))
    : null;

  const sendDraft = () => {
    const question = draft.trim();
    if (!peer || !question || ask.isPending) return;
    ask.mutate(question);
  };

  const openThread = (id: string) => setPeer(id);
  const closeThread = () => setPeer(null);

  // ---- full-height thread view (replaces the feed) ----
  if (peer !== null) {
    return (
      <div className="flex flex-col h-full bg-gray-100">
        <div className="flex items-center justify-between p-3 bg-white border-b border-gray-200">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <button
              className="inline-flex items-center gap-1 text-gray-400 hover:text-gray-700"
              onClick={closeThread}
              title="返回消息流"
            >
              <ArrowLeft size={13} /> 返回
            </button>
            <span className="text-gray-300">|</span>
            {peerSession && <StatusDot status={peerSession.status} busy={peerSession.busy} />}
            <span className="font-medium">与 {peerName} 的对话</span>
            <span className="text-gray-400">每 5 秒刷新</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {(thread.data?.messages ?? []).length === 0 && (
            <div className="text-xs text-gray-400 text-center py-6">暂无往来消息</div>
          )}
          {(thread.data?.messages ?? []).map((m) => {
            const mine = m.from_session === WEB_CONSOLE_ID;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-xs ${
                    mine
                      ? "bg-blue-500 text-white"
                      : "bg-gray-100 text-gray-800 border border-gray-200"
                  }`}
                >
                  <MarkdownText tone={mine ? "blue" : "light"}>{m.question}</MarkdownText>
                  {m.reply && (
                    <div
                      className={`mt-2 pt-2 border-t ${
                        mine ? "border-blue-400/50" : "border-gray-200"
                      }`}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-60 mb-0.5">
                        回复
                      </div>
                      <MarkdownText>{m.reply}</MarkdownText>
                    </div>
                  )}
                  {mine && m.status === "pending" && (
                    <div className="mt-1 text-[10px] text-blue-200">等待对方处理…</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {/* fixed-target composer */}
        <div className="p-3 bg-white border-t border-gray-200">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder={`向 ${peerName} 提问…（回车发送）`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendDraft();
                }
              }}
              className="flex-1 bg-white text-gray-800 text-sm rounded-lg px-3 py-2 border border-gray-200 placeholder-gray-400 outline-none focus:border-blue-500"
            />
            <button
              onClick={sendDraft}
              disabled={!draft.trim() || ask.isPending}
              className="inline-flex items-center gap-1.5 text-sm text-white bg-blue-500 hover:bg-blue-600 rounded-lg px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={13} /> 发送
            </button>
          </div>
          {ask.isError && (
            <div className="text-xs text-red-500 mt-1">
              发送失败: {(ask.error as Error).message}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- feed view ----
  return (
    <div className="flex flex-col h-full bg-gray-100">
      {/* ---- @ composer ---- */}
      <div className="p-3 bg-white border-b border-gray-200">
        <MentionComposer onSent={(t) => openThread(t.id)} />
      </div>

      {/* ---- list filters ---- */}
      <div className="flex items-center gap-2 p-3 bg-white border-b border-gray-200">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-white text-gray-700 text-xs rounded-lg px-2.5 py-1.5 border border-gray-200 outline-none focus:border-blue-500"
        >
          <option value="all">全部状态</option>
          <option value="pending">待回复</option>
          <option value="seen">已读未答</option>
          <option value="replied">已回复</option>
          <option value="read">已读</option>
        </select>
        <input
          type="text"
          placeholder="搜索消息内容..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-white text-gray-800 text-xs rounded-lg px-2.5 py-1.5 border border-gray-200 placeholder-gray-400 outline-none focus:border-blue-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading && <div className="text-gray-400 text-sm text-center mt-8">加载中...</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="text-gray-400 text-sm text-center mt-8">
            {search ? "无匹配消息" : "暂无消息"}
          </div>
        )}
        {filtered.map((msg) => (
          <MessageCard
            key={msg.id}
            msg={msg}
            fromName={nameMap.get(msg.from_session)}
            toName={nameMap.get(msg.to_session)}
            toStatus={statusMap.get(msg.to_session)}
            onClick={() => {
              onSelectMessage(msg);
              openThread(msg.from_session === WEB_CONSOLE_ID ? msg.to_session : msg.from_session);
            }}
            selected={msg.id === selectedMessageId}
          />
        ))}
      </div>
    </div>
  );
}
