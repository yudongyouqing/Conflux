import { ArrowRight } from "lucide-react";
import type { Message } from "../types";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border border-amber-200",
  replied: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  read: "bg-blue-50 text-blue-700 border border-blue-200",
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
      className={`p-3 rounded-xl border cursor-pointer transition-all ${
        selected
          ? "border-blue-500 bg-blue-50/50 shadow-sm"
          : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="text-gray-700 font-medium">
          {fromName ?? msg.from_session.slice(0, 8)}
        </span>
        <ArrowRight size={12} className="text-gray-400" />
        <span className="text-gray-700 font-medium">
          {toName ?? msg.to_session.slice(0, 8)}
        </span>
        <span
          className={`ml-auto px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
            STATUS_COLORS[msg.status] ?? "bg-gray-100 text-gray-500 border border-gray-200"
          }`}
        >
          {msg.status}
        </span>
      </div>
      <div className="text-sm text-gray-800 truncate">{msg.question}</div>
      {msg.reply && (
        <div className="text-xs text-gray-500 truncate mt-1">
          ↳ {msg.reply}
        </div>
      )}
    </div>
  );
}
