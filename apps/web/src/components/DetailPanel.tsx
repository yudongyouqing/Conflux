import { useSessionContext } from "../hooks";
import type { Message, GraphNode } from "@muiltchat/shared";
import { StatusDot } from "./StatusDot";
import { FileText, Clock, ArrowRight } from "lucide-react";

interface DetailPanelProps {
  session: GraphNode | null;
  message: Message | null;
  sessionNameLookup: (id: string) => string | undefined;
}

export function DetailPanel({
  session,
  message,
  sessionNameLookup,
}: DetailPanelProps) {
  const { data: contextEntries } = useSessionContext(session?.id ?? null);

  if (session) {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <StatusDot status={session.status} />
            <h2 className="text-gray-900 font-semibold text-[15px]">{session.name}</h2>
          </div>
          <div className="text-[10px] text-gray-400 font-mono break-all">
            {session.id}
          </div>
        </div>

        <div className="flex gap-5 text-xs">
          <div>
            <span className="text-gray-400">上下文</span>
            <div className="text-gray-800 font-medium mt-0.5">{session.context_count}</div>
          </div>
          <div>
            <span className="text-gray-400">待处理</span>
            <div className="text-amber-600 font-medium mt-0.5">{session.pending_inbox}</div>
          </div>
          <div>
            <span className="text-gray-400">类型</span>
            <div className="text-gray-800 font-medium mt-0.5">
              {session.type === "agent" ? "Agent" : "会话"}
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-xs text-gray-500 font-medium mb-2 flex items-center gap-1">
            <FileText size={12} /> 已发布上下文
          </h3>
          {!contextEntries || contextEntries.entries.length === 0 ? (
            <p className="text-xs text-gray-400">无</p>
          ) : (
            <div className="space-y-2">
              {contextEntries.entries.map((e) => (
                <div
                  key={e.id}
                  className="p-3 rounded-xl bg-gray-50 border border-gray-200"
                >
                  <div className="text-xs text-gray-800 font-medium">
                    {e.title}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1 line-clamp-3">
                    {e.content}
                  </div>
                  {e.tags && e.tags.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {e.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-600 border border-blue-100"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message) {
    return (
      <div className="p-5 space-y-4 overflow-y-auto h-full">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-700 font-medium">
            {sessionNameLookup(message.from_session) ??
              message.from_session.slice(0, 8)}
          </span>
          <ArrowRight size={12} className="text-gray-400" />
          <span className="text-gray-700 font-medium">
            {sessionNameLookup(message.to_session) ??
              message.to_session.slice(0, 8)}
          </span>
          <span
            className={`ml-auto px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
              message.status === "pending"
                ? "bg-amber-50 text-amber-700 border border-amber-200"
                : message.status === "replied"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-blue-50 text-blue-700 border border-blue-200"
            }`}
          >
            {message.status}
          </span>
        </div>

        <div>
          <div className="text-[10px] text-gray-400 mb-1.5 flex items-center gap-1">
            <Clock size={10} /> {new Date(message.created_at).toLocaleString()}
          </div>
          <div className="text-sm text-gray-800 whitespace-pre-wrap bg-gray-50 p-3 rounded-xl border border-gray-200">
            {message.question}
          </div>
        </div>

        {message.reply && (
          <div>
            <div className="text-[10px] text-gray-400 mb-1.5">
              回复
              {message.replied_at &&
                ` · ${new Date(message.replied_at).toLocaleString()}`}
            </div>
            <div className="text-sm text-emerald-800 whitespace-pre-wrap bg-emerald-50 p-3 rounded-xl border border-emerald-200">
              {message.reply}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full text-gray-400 text-sm text-center px-6">
      点击图节点或消息条目查看详情
    </div>
  );
}
