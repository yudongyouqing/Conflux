import { useState, useMemo } from "react";
import { useMessages, useGraph } from "../hooks";
import { MessageCard } from "./MessageCard";
import type { Message } from "../types";

interface MessageTabProps {
  onSelectMessage: (msg: Message | null) => void;
  selectedMessageId: number | null;
}

export function MessageTab({
  onSelectMessage,
  selectedMessageId,
}: MessageTabProps) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useMessages({ status: statusFilter });
  const graph = useGraph();

  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    graph.data?.nodes.forEach((n) => m.set(n.id, n.name));
    return m;
  }, [graph.data]);

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

  return (
    <div className="flex flex-col h-full bg-gray-100">
      <div className="flex items-center gap-2 p-3 bg-white border-b border-gray-200">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-white text-gray-700 text-xs rounded-lg px-2.5 py-1.5 border border-gray-200 outline-none focus:border-blue-500"
        >
          <option value="all">全部状态</option>
          <option value="pending">待回复</option>
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
            onClick={() => onSelectMessage(msg)}
            selected={msg.id === selectedMessageId}
          />
        ))}
      </div>
    </div>
  );
}
