import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGraph, useMessages, usePeerMessages, useSessions } from "../hooks";
import { api } from "../api";
import { MentionComposer } from "./MentionComposer";
import { MessageCard } from "./MessageCard";
import { MarkdownText } from "./MarkdownText";
import { StatusDot } from "./StatusDot";
import { Search, Inbox, Send } from "lucide-react";
import type { Message, SessionSummary } from "@muiltchat/shared";

interface WorkbenchTabProps {
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
  onSelectMessage: (msg: Message | null) => void;
  selectedMessageId: number | null;
}

function relative(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h 前`;
  return `${Math.floor(sec / 86400)}d 前`;
}

/** Sessions × message feed merged into one two-pane workbench (issue #14):
 * left = session list (project groups, recency, live badges, search);
 * right = message context — global feed when nothing is selected, the
 * thread with the selected session (plus a fixed-target composer) when it is. */
export function WorkbenchTab({
  onSelectSession,
  selectedSessionId,
  onSelectMessage,
  selectedMessageId,
}: WorkbenchTabProps) {
  const [q, setQ] = useState("");
  const [peer, setPeer] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");

  const sessions = useSessions("all");
  const graph = useGraph();
  const { data, isLoading } = useMessages({ status: statusFilter });
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

  // an external selection change (e.g. graph tab) re-opens that thread here;
  // collapsing locally does not touch the app-level selection
  useEffect(() => {
    setPeer(selectedSessionId);
  }, [selectedSessionId]);

  const groups = useMemo(() => {
    const all = (sessions.data?.sessions ?? []).filter((s) => {
      if (!q.trim()) return true;
      const needle = q.trim().toLowerCase();
      return (
        s.name.toLowerCase().includes(needle) ||
        (s.description ?? "").toLowerCase().includes(needle) ||
        (s.project_dir ?? "").toLowerCase().includes(needle)
      );
    });
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of all) {
      const key = s.project_dir ?? "(未知项目)";
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }
    // freshest project first; freshest session first within a project
    return [...byProject.entries()]
      .map(([dir, list]) => ({
        dir,
        list: list.sort((a, b) => b.last_heartbeat_at.localeCompare(a.last_heartbeat_at)),
        latest: list.reduce((m, s) => (s.last_heartbeat_at > m ? s.last_heartbeat_at : m), ""),
      }))
      .sort((a, b) => b.latest.localeCompare(a.latest));
  }, [sessions.data, q]);

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

  return (
    <div className="flex h-full">
      {/* ---- left: session list ---- */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-3 z-10">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索名称 / 正在做什么 / 项目路径…"
              className="w-full text-xs pl-7 pr-2 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300"
            />
          </div>
        </div>
        {groups.length === 0 ? (
          <div className="p-6 text-center text-xs text-gray-400">没有匹配的会话</div>
        ) : (
          <div className="p-3 space-y-4">
            {groups.map((g) => (
              <div key={g.dir}>
                <div
                  className="text-[11px] font-medium text-gray-500 truncate mb-1.5 px-1"
                  title={g.dir}
                >
                  {g.dir}
                </div>
                <div className="space-y-1">
                  {g.list.map((s: SessionSummary) => {
                    const selected = s.id === selectedSessionId;
                    return (
                      <button
                        key={s.id}
                        onClick={() => onSelectSession(s.id)}
                        className={`w-full text-left px-3 py-2 rounded-xl border transition-colors ${
                          selected
                            ? "bg-white border-blue-300 ring-2 ring-blue-500/30"
                            : "bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <StatusDot status={s.status} busy={s.busy} />
                          <span className="text-xs font-medium text-gray-900 truncate flex-1">
                            {s.name}
                          </span>
                          <span className="text-[10px] text-gray-400 flex-shrink-0">
                            {relative(s.last_heartbeat_at)}
                          </span>
                        </div>
                        {s.description && s.description !== "Claude Code session (hook)" && (
                          <div
                            className="text-[11px] text-gray-500 truncate mt-0.5"
                            title={s.description}
                          >
                            {s.description}
                          </div>
                        )}
                        {s.pending_inbox > 0 && (
                          <div className="flex items-center gap-1 text-[10px] text-amber-600 mt-0.5">
                            <Inbox size={10} /> {s.pending_inbox} 待回复
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- right: message context ---- */}
      <div className="flex-1 flex flex-col bg-gray-100 overflow-hidden">
        {peer === null ? (
          <>
            {/* landing: global composer + feed */}
            <div className="p-3 bg-white border-b border-gray-200">
              <MentionComposer onSent={(t) => setPeer(t.id)} />
            </div>
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
                    setPeer(msg.from_session === "web-console" ? msg.to_session : msg.from_session);
                  }}
                  selected={msg.id === selectedMessageId}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* thread with one session */}
            <div className="flex items-center justify-between p-3 bg-white border-b border-gray-200">
              <div className="flex items-center gap-2 text-xs text-gray-600">
                {peerSession && <StatusDot status={peerSession.status} busy={peerSession.busy} />}
                <span className="font-medium">与 {peerName} 的对话</span>
                <span className="text-gray-400">每 5 秒刷新</span>
              </div>
              <button
                className="text-xs text-gray-400 hover:text-gray-700"
                onClick={() => setPeer(null)}
              >
                收起
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {(thread.data?.messages ?? []).length === 0 && (
                <div className="text-xs text-gray-400 text-center py-6">暂无往来消息</div>
              )}
              {(thread.data?.messages ?? []).map((m) => {
                const mine = m.from_session === "web-console";
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
                          <div className="text-[9px] font-semibold uppercase tracking-wide opacity-60 mb-0.5">
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
                <div className="text-xs text-red-500 mt-1">发送失败: {(ask.error as Error).message}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
