import { useMemo, useState } from "react";
import { useMessages, useGraph, useSessions, useEdgeMessages, useEdgeAsk } from "../hooks";
import { MentionComposer } from "./MentionComposer";
import { MessageCard } from "./MessageCard";
import { MarkdownText } from "./MarkdownText";
import { StatusDot } from "./StatusDot";
import { ArrowLeft, Send, Loader2 } from "lucide-react";
import { WEB_CONSOLE_ID, type Message } from "@conflux/shared";

interface MessageTabProps {
  /** the activity view only polls (and runs its inbox side effect) while visible */
  active: boolean;
  onSelectMessage: (msg: Message | null) => void;
  selectedMessageId: number | null;
  /** a feed entry with a clear peer continues in the workspace conversation */
  onOpenPeerConversation: (sessionId: string) => void;
}

/**
 * Activity history (原「消息流」): the global feed with filters, retry and
 * details. Entries between two EXTERNAL sessions open their channel (edge)
 * view here; anything involving the web console jumps to the workspace's
 * peer conversation instead — never a web-console-flavored copy of someone
 * else's channel. All polling (and the inbox preflight inside useMessages)
 * is gated on `active`.
 */
export function MessageTab({
  active,
  onSelectMessage,
  selectedMessageId,
  onOpenPeerConversation,
}: MessageTabProps) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  // Open conversation: a CHANNEL (edge — any A→B pair between external
  // sessions). Peer conversations live in the workspace now.
  const [conv, setConv] = useState<{ edgeId: number; from: string; to: string } | null>(null);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useMessages({ status: statusFilter }, active);
  const graph = useGraph();
  const sessions = useSessions("active");
  const channel = conv;
  const channelMsgs = useEdgeMessages(channel?.edgeId ?? null, active);
  const edgeAsk = useEdgeAsk();

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

  const nameOf = (id: string) => nameMap.get(id) ?? id.slice(0, 8);
  // edge endpoint list arrives newest-first (EdgeFlowView contract); the
  // bubble stream wants chronological order
  const channelList = (channelMsgs.data?.messages ?? []).slice().reverse();
  const fromSession = sessions.data?.sessions?.find((s) => s.id === channel?.from);

  const sendDraft = () => {
    const question = draft.trim();
    if (!question || !channel || edgeAsk.isPending) return;
    edgeAsk.mutate({ edgeId: channel.edgeId, question }, { onSuccess: () => setDraft("") });
  };

  // ---- full-height channel view (replaces the feed) ----
  if (channel) {
    return (
      <div className="flex flex-col h-full bg-paper">
        <div className="flex items-center justify-between p-3 bg-surface border-b border-line">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <button
              className="inline-flex items-center gap-1 text-ink-faint hover:text-ink"
              onClick={() => setConv(null)}
              title="返回活动记录"
            >
              <ArrowLeft size={13} /> 返回
            </button>
            <span className="text-ink-faint">|</span>
            {fromSession && <StatusDot status={fromSession.status} busy={fromSession.busy} />}
            <span className="font-medium">
              {nameOf(channel.from)} 与 {nameOf(channel.to)} 的对话
            </span>
            <span className="text-ink-faint">每 5 秒刷新</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl mx-auto space-y-2">
            {channelMsgs.isLoading && channelList.length === 0 && (
              <div className="flex justify-center py-8">
                <Loader2 size={16} className="text-ink-faint animate-spin" />
              </div>
            )}
            {channelList.length === 0 && !channelMsgs.isLoading && (
              <div className="text-xs text-ink-faint text-center py-6">暂无往来消息</div>
            )}
            {channelList.map((m) => {
              // Ask and answer are SEPARATE bubbles: the question rides the
              // asker's side, the reply the answerer's — a chat exchange, not
              // a Q/A card.
              const mine = m.from_session === channel.from;
              return (
                <div key={m.id} className="space-y-2">
                  <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[85%] sm:max-w-[68%] min-w-0">
                      <div
                        className={`rounded-xl px-3 py-2 text-xs ${
                          mine ? "bg-accent text-on-accent" : "bg-paper text-ink border border-line"
                        }`}
                      >
                        <MarkdownText tone={mine ? "blue" : "light"}>{m.question}</MarkdownText>
                        {mine && m.status === "pending" && (
                          <div className="mt-1 text-2xs text-on-accent/80">等待对方读取…</div>
                        )}
                      </div>
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
              placeholder={`以 ${nameOf(channel.from)} 身份在通道 #${channel.edgeId} 发言…（回车发送）`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendDraft();
                }
              }}
              className="flex-1 bg-surface text-ink text-sm rounded-lg px-3 py-2 border border-line placeholder-ink-faint outline-none focus:border-accent"
            />
            <button
              onClick={sendDraft}
              disabled={!draft.trim() || edgeAsk.isPending}
              className="inline-flex items-center gap-1.5 text-sm text-on-accent bg-accent hover:bg-accent-deep rounded-lg px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {edgeAsk.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Send size={13} />
              )}
              发送
            </button>
          </div>
          {edgeAsk.isError && (
            <div className="text-xs text-danger mt-1">
              发送失败: {(edgeAsk.error as Error).message}
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
          <MentionComposer onSent={(t) => onOpenPeerConversation(t.id)} />
        </div>
      </div>

      {/* ---- list filters ---- */}
      <div className="p-3 bg-surface border-b border-line">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="状态筛选"
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
            aria-label="搜索消息内容"
            className="flex-1 bg-surface text-ink text-xs rounded-lg px-2.5 py-1.5 border border-line placeholder-ink-faint outline-none focus:border-accent"
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
                // The full-height channel view IS the detail view — the
                // side DetailPanel must not light up next to it. External
                // A↔B channels keep their edge view here; anything with the
                // web console as an endpoint continues in the workspace's
                // peer conversation on the message's full session id.
                onSelectMessage(null);
                const externalChannel =
                  msg.edge_id != null &&
                  msg.from_session !== WEB_CONSOLE_ID &&
                  msg.to_session !== WEB_CONSOLE_ID;
                if (externalChannel) {
                  setConv({
                    edgeId: msg.edge_id!,
                    from: msg.from_session,
                    to: msg.to_session,
                  });
                } else {
                  onOpenPeerConversation(
                    msg.from_session === WEB_CONSOLE_ID ? msg.to_session : msg.from_session,
                  );
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
