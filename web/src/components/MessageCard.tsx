import { ArrowRight } from "lucide-react";
import type { Message } from "../types";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400",
  replied: "bg-green-500/20 text-green-400",
  read: "bg-blue-500/20 text-blue-400",
};

interface MessageCardProps {
  msg: Message;
  fromName?: string;
  toName?: string;
  onClick: () => void;
  selected: boolean;
}

export function MessageCard({
  msg,
  fromName,
  toName,
  onClick,
  selected,
}: MessageCardProps) {
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
        selected
          ? "border-blue-500 bg-slate-700/50"
          : "border-slate-700 bg-slate-800/50 hover:bg-slate-700/30"
      }`}
    >
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="text-slate-300 font-medium">
          {fromName ?? msg.from_session.slice(0, 8)}
        </span>
        <ArrowRight size={12} className="text-slate-500" />
        <span className="text-slate-300 font-medium">
          {toName ?? msg.to_session.slice(0, 8)}
        </span>
        <span
          className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium ${
            STATUS_COLORS[msg.status] ?? "bg-slate-700 text-slate-400"
          }`}
        >
          {msg.status}
        </span>
      </div>
      <div className="text-sm text-slate-200 truncate">{msg.question}</div>
      {msg.reply && (
        <div className="text-xs text-slate-400 truncate mt-1">
          ↳ {msg.reply}
        </div>
      )}
    </div>
  );
}
