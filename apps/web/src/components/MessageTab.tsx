import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMessages, useGraph, useSessions, usePeerMessages, useEdgeMessages, useEdgeAsk } from "../hooks";
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
  // Open conversation: either a CHANNEL (edge — any A→B pair, the common case
  // when clicking a feed card) or a plain web-console↔peer thread (composer
  // sends). Channel mode shows the full exchange and speaks as the channel's
  // initiator; peer mode is the legacy web-only view.
  const [conv, setConv] = useState<
    { kind: "edge"; edgeId: number; from: string; to: string } | { kind: "peer"; peer: string } | null
  >(null);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useMessages({ status: statusFilter });
  const graph = useGraph();
  const sessions = useSessions("active");
  const peer = conv?.kind === "peer" ? conv.peer : null;
  const thread = usePeerMessages(peer);
  const channel = conv?.kind === "edge" ? conv : null;
  const channelMsgs = useEdgeMessages(channel?.edgeId ?? null);
  const edgeAsk = useEdgeAsk();

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
  const nameOf = (id: string) => nameMap.get(id) ?? id.slice(0, 8);
  // edge endpoint list arrives newest-first (EdgeFlowView contract); the
  // bubble stream wants chronological order
  const channelList = (channelMsgs.data?.messages ?? []).slice().reverse();
  const fromSession = sessions.data?.sessions.find((s) => s.id === channel?.from);

  const sendDraft = () => {
    const question = draft.trim();
    if (!question) return;
    if (channel) {
      if (edgeAsk.isPending) return;
      edgeAsk.mutate(
        { edgeId: channel.edgeId, question },
        { onSuccess: () => setDraft("") },
      );
      return;
    }
    if (!peer || ask.isPending) return;
    ask.mutate(question);
  };
  const sending = channel ? edgeAsk.isPending : ask.isPending;
  const askError = channel ? edgeAsk.error : ask.error;

  const openThread = (id: string) => setConv({ kind: "peer", peer: id });
  const closeThread = () => setConv(null);

  // ---- full-height conversation view (replaces the feed) ----
  if (conv !== null) {
    return (
      <div className="flex flex-col h-full bg-paper">
        <div className="flex items-center justify-between p-3 bg-surface border-b border-line">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <button
              className="inline-flex items-center gap-1 text-ink-faint hover:text-ink"
              onClick={closeThread}
              title="返回消息流"
            >
              <ArrowLeft size={13} /> 返回
            </button>
            <span className="text-ink-faint">|</span>
            {channel ? (
              <>
                {fromSession && <StatusDot status={fromSession.status} busy={fromSession.busy} />}
                <span className="font-medium">
                  {nameOf(channel.from)} 与 {nameOf(channel.to)} 的对话
                </span>
              </>
            ) : (
              <>
                {peerSession && <StatusDot status={peerSession.status} busy={peerSession.busy} />}
                <span className="font-medium">与 {peerName} 的对话</span>
              </>
            )}
            <span className="text-ink-faint">每 5 秒刷新</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl mx-auto space-y-2">
          {(channel ? channelList : (thread.data?.messages ?? [])).length === 0 && (
            <div className="text-xs text-ink-faint text-center py-6">暂无往来消息</div>
          )}
          {(channel ? channelList : (thread.data?.messages ?? [])).map((m) => {
            // Ask and answer are SEPARATE bubbles: the question rides the
            // asker's side, the reply the answerer's — a chat exchange, not
            // a Q/A card.
            const mine = channel ? m.from_session === channel.from : m.from_session === WEB_CONSOLE_ID;
            return (
              <div key={m.id} className="space-y-2">
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[68%] rounded-xl px-3 py-2 text-xs ${
                      mine ? "bg-accent text-white" : "bg-paper text-ink border border-line"
                    }`}
                  >
                    <MarkdownText tone={mine ? "blue" : "light"}>{m.question}</MarkdownText>
                    {mine && m.status === "pending" && (
                      <div className="mt-1 text-[10px] text-white/70">等待对方处理…</div>
                    )}
                  </div>
                </div>
                {m.reply && (
                  <div className={`flex ${mine ? "justify-start" : "justify-end"}`}>
                    <div className="max-w-[68%] rounded-xl px-3 py-2 text-xs bg-paper text-ink border border-line">
                      <MarkdownText>{m.reply}</MarkdownText>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </div>
        {/* fixed-target composer */}
        <div className="p-3 bg-surface border-t border-line">
          <div className="flex items-center gap-2 max-w-3xl mx-auto">
            <input
              type="text"
              placeholder={
                channel
                  ? `以 ${nameOf(channel.from)} 身份在通道 #${channel.edgeId} 发言…（回车发送）`
                  : `向 ${peerName} 提问…（回车发送）`
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendDraft();
                }
              }}
              className="flex-1 bg-surface text-ink text-sm rounded-lg px-3 py-2 border border-line placeholder-gray-400 outline-none focus:border-accent"
            />
            <button
              onClick={sendDraft}
              disabled={!draft.trim() || sending}
              className="inline-flex items-center gap-1.5 text-sm text-white bg-accent hover:bg-accent-deep rounded-lg px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={13} /> 发送
            </button>
          </div>
          {askError && (
            <div className="text-xs text-red-500 mt-1">
              发送失败: {(askError as Error).message}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- feed view ----
  // Content column is width-capped and centered (ChatPanel pattern): a
  // full-bleed feed leaves empty states stranded left on wide screens and
  // stretches message cards past a readable line length.
  return (
    <div className="flex flex-col h-full bg-paper">
      {/* ---- @ composer ---- */}
      <div className="p-3 bg-surface border-b border-line">
        <div className="max-w-3xl mx-auto">
          <MentionComposer onSent={(t) => openThread(t.id)} />
        </div>
      </div>

      {/* ---- list filters ---- */}
      <div className="p-3 bg-surface border-b border-line">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-surface text-ink text-xs rounded-lg px-2.5 py-1.5 border border-line outline-none focus:border-accent"
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
          className="flex-1 bg-surface text-ink text-xs rounded-lg px-2.5 py-1.5 border border-line placeholder-gray-400 outline-none focus:border-accent"
        />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-2">
          {isLoading && <div className="text-ink-faint text-sm text-center mt-8">加载中...</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="text-ink-faint text-sm text-center mt-8">
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
              // The full-height conversation view IS the detail view — the
              // side DetailPanel must not light up next to it. Feed cards
              // open the message's CHANNEL (any A→B pair) — the web-console
              // peer thread would be empty for third-party exchanges.
              onSelectMessage(null);
              if (msg.edge_id != null) {
                setConv({ kind: "edge", edgeId: msg.edge_id, from: msg.from_session, to: msg.to_session });
              } else {
                openThread(msg.from_session === WEB_CONSOLE_ID ? msg.to_session : msg.from_session);
              }
            }}
            selected={msg.id === selectedMessageId}
          />
        ))}
        </div>
      </div>
    </div>
  );
}
