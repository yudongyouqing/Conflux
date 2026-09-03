import { useMemo, useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMessages, useGraph, useSessions, usePeerMessages } from "../hooks";
import { api } from "../api";
import { MessageCard } from "./MessageCard";
import { StatusDot } from "./StatusDot";
import type { Message, SessionSummary } from "@muiltchat/shared";

interface MessageTabProps {
  onSelectMessage: (msg: Message | null) => void;
  selectedMessageId: number | null;
}

function targetBadge(s: SessionSummary): { text: string; color: string } {
  if (s.status !== "active") return { text: "离线 · 异步投递", color: "text-gray-400" };
  if (s.busy) return { text: "在线 · 正在回复", color: "text-amber-600" };
  return { text: "在线", color: "text-emerald-600" };
}

export function MessageTab({
  onSelectMessage,
  selectedMessageId,
}: MessageTabProps) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useMessages({ status: statusFilter });
  const graph = useGraph();
  const sessions = useSessions("active");
  const queryClient = useQueryClient();

  // ---- @ composer state ----
  const [text, setText] = useState("");
  const [target, setTarget] = useState<SessionSummary | null>(null);
  const [peer, setPeer] = useState<string | null>(null); // open thread with this session
  const inputRef = useRef<HTMLInputElement>(null);
  const thread = usePeerMessages(peer);

  const { nameMap, statusMap } = useMemo(() => {
    const names = new Map<string, string>();
    const statuses = new Map<string, string>();
    graph.data?.nodes.forEach((n) => {
      names.set(n.id, n.name);
      statuses.set(n.id, n.status);
    });
    return { nameMap: names, statusMap: statuses };
  }, [graph.data]);

  // typing "@..." with no target yet → mention picker; query = chars after @
  const mentionQuery = useMemo(() => {
    if (target) return null;
    const m = /@([^\s@]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text, target]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return (sessions.data?.sessions ?? [])
      .filter((s) => s.id !== "web-console" && !s.id.startsWith("agent-"))
      .filter(
        (s) =>
          s.name.toLowerCase().includes(mentionQuery) ||
          s.id.toLowerCase().includes(mentionQuery)
      )
      .slice(0, 6);
  }, [sessions.data, mentionQuery]);

  const ask = useMutation({
    mutationFn: (body: { to_session: string; question: string }) => api.webAsk(body),
    onSuccess: (_data, vars) => {
      setPeer(vars.to_session);
      setText("");
      setTarget(null);
      inputRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: ["peer-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const pickTarget = (s: SessionSummary) => {
    setTarget(s);
    setText((t) => t.replace(/@([^\s@]*)$/, ""));
    inputRef.current?.focus();
  };

  const send = () => {
    const question = text.trim();
    if (!target || !question || ask.isPending) return;
    ask.mutate({ to_session: target.id, question });
  };

  const messages = data?.messages ?? [];

  const filtered = useMemo(
    () =>
      search
        ? messages.filter(
            (m) =>
              m.question.toLowerCase().includes(search.toLowerCase()) ||
              (m.reply?.toLowerCase().includes(search.toLowerCase()) ?? false)
          )
        : messages,
    [messages, search]
  );

  const peerName = peer ? nameMap.get(peer) ?? sessions.data?.sessions.find((s) => s.id === peer)?.name : null;
  const peerSession = sessions.data?.sessions.find((s) => s.id === peer);

  return (
    <div className="flex flex-col h-full bg-gray-100">
      {/* ---- @ composer ---- */}
      <div className="p-3 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          {target ? (
            <span className="inline-flex items-center gap-1.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full pl-2 pr-1 py-1">
              <StatusDot status={target.status} busy={target.busy} />
              <span className="max-w-40 truncate">{target.name}</span>
              <button
                className="text-blue-400 hover:text-blue-700 px-1"
                onClick={() => setTarget(null)}
                title="移除目标"
              >
                ×
              </button>
            </span>
          ) : (
            <span className="text-xs text-gray-400 whitespace-nowrap">输入 @ 选择会话</span>
          )}
          {target && (
            <span className={`text-[11px] ${targetBadge(target).color}`}>
              {targetBadge(target).text}
            </span>
          )}
        </div>
        <div className="relative mt-2">
          <input
            ref={inputRef}
            type="text"
            placeholder={target ? `向 ${target.name} 提问…（回车发送）` : "@某个会话 提问，例如：@server 帮我看看构建"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (candidates.length > 0 && mentionQuery !== null) {
                  e.preventDefault();
                  pickTarget(candidates[0]);
                } else {
                  send();
                }
              }
              if (e.key === "Escape") {
                if (target) setTarget(null);
                else setText("");
              }
            }}
            className="w-full bg-white text-gray-800 text-sm rounded-lg px-3 py-2 border border-gray-200 placeholder-gray-400 outline-none focus:border-blue-500"
          />
          {mentionQuery !== null && candidates.length > 0 && (
            <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {candidates.map((s) => (
                <button
                  key={s.id}
                  onClick={() => pickTarget(s)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-50"
                >
                  <StatusDot status={s.status} busy={s.busy} />
                  <span className="text-sm text-gray-800 truncate max-w-56">{s.name}</span>
                  <span className="text-[11px] text-gray-400 truncate flex-1">
                    {s.description ?? s.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {ask.isError && (
          <div className="text-xs text-red-500 mt-1">发送失败: {(ask.error as Error).message}</div>
        )}
      </div>

      {/* ---- open thread with one peer ---- */}
      {peer && (
        <div className="p-3 bg-white border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs text-gray-600">
              {peerSession && <StatusDot status={peerSession.status} busy={peerSession.busy} />}
              <span className="font-medium">与 {peerName ?? peer.slice(0, 8)} 的对话</span>
              <span className="text-gray-400">每 5 秒刷新</span>
            </div>
            <button className="text-xs text-gray-400 hover:text-gray-700" onClick={() => setPeer(null)}>
              收起
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-2">
            {(thread.data?.messages ?? []).length === 0 && (
              <div className="text-xs text-gray-400 text-center py-3">暂无往来消息</div>
            )}
            {(thread.data?.messages ?? []).map((m) => {
              const mine = m.from_session === "web-console";
              return (
                <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-xl px-3 py-2 text-xs ${
                      mine ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-800 border border-gray-200"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">{m.question}</div>
                    {m.reply && (
                      <div
                        className={`mt-1 pt-1 border-t whitespace-pre-wrap break-words ${
                          mine ? "border-blue-400/50" : "border-gray-200"
                        }`}
                      >
                        <span className="opacity-60">回复: </span>
                        {m.reply}
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
        </div>
      )}

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
        {isLoading && (
          <div className="text-gray-400 text-sm text-center mt-8">
            加载中...
          </div>
        )}
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
    </div>
  );
}
