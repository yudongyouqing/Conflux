import { useSessionContext } from "../hooks";
import type { Message, GraphNode } from "../types";
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
      <div className="p-4 space-y-4 overflow-y-auto h-full">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={session.status} />
            <h2 className="text-white font-semibold text-sm">{session.name}</h2>
          </div>
          <div className="text-[10px] text-slate-600 font-mono break-all">
            {session.id}
          </div>
        </div>

        <div className="flex gap-4 text-xs">
          <div>
            <span className="text-slate-500">上下文</span>
            <span className="text-slate-200 ml-1.5">{session.context_count}</span>
          </div>
          <div>
            <span className="text-slate-500">待处理</span>
            <span className="text-amber-400 ml-1.5">{session.pending_inbox}</span>
          </div>
          <div>
            <span className="text-slate-500">状态</span>
            <span className="text-slate-300 ml-1.5">{session.status}</span>
          </div>
        </div>

        <div>
          <h3 className="text-xs text-slate-400 font-medium mb-2 flex items-center gap-1">
            <FileText size={12} /> 已发布上下文
          </h3>
          {!contextEntries || contextEntries.entries.length === 0 ? (
            <p className="text-xs text-slate-600">无</p>
          ) : (
            <div className="space-y-2">
              {contextEntries.entries.map((e) => (
                <div
                  key={e.id}
                  className="p-2 rounded bg-slate-800/50 border border-slate-700"
                >
                  <div className="text-xs text-slate-300 font-medium">
                    {e.title}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 line-clamp-3">
                    {e.content}
                  </div>
                  {e.tags && e.tags.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {e.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400"
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
      <div className="p-4 space-y-3 overflow-y-auto h-full">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-300 font-medium">
            {sessionNameLookup(message.from_session) ??
              message.from_session.slice(0, 8)}
          </span>
          <ArrowRight size={12} className="text-slate-600" />
          <span className="text-slate-300 font-medium">
            {sessionNameLookup(message.to_session) ??
              message.to_session.slice(0, 8)}
          </span>
          <span
            className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium ${
              message.status === "pending"
                ? "bg-amber-500/20 text-amber-400"
                : message.status === "replied"
                  ? "bg-green-500/20 text-green-400"
                  : "bg-blue-500/20 text-blue-400"
            }`}
          >
            {message.status}
          </span>
        </div>

        <div>
          <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1">
            <Clock size={10} /> {new Date(message.created_at).toLocaleString()}
          </div>
          <div className="text-sm text-slate-200 whitespace-pre-wrap bg-slate-800/50 p-3 rounded border border-slate-700">
            {message.question}
          </div>
        </div>

        {message.reply && (
          <div>
            <div className="text-[10px] text-slate-500 mb-1">
              回复
              {message.replied_at &&
                ` · ${new Date(message.replied_at).toLocaleString()}`}
            </div>
            <div className="text-sm text-green-300/90 whitespace-pre-wrap bg-green-950/20 p-3 rounded border border-green-800/40">
              {message.reply}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full text-slate-600 text-sm text-center px-4">
      点击图节点或消息条目查看详情
    </div>
  );
}
