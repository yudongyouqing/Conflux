import { ArrowRight } from "lucide-react";
import { InlineMarkdown } from "./InlineMarkdown";
import type { Message } from "@conflux/shared";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border border-amber-200",
  seen: "bg-violet-50 text-violet-700 border border-violet-200",
  replied: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  read: "bg-accent-soft text-accent-deep border border-accent/30",
};

interface MessageCardProps {
  msg: Message;
  fromName?: string;
  toName?: string;
  /** Graph status of the target session — offline + undelivered = dead letter. */
  toStatus?: string;
  onClick: () => void;
  selected: boolean;
}

export function MessageCard({
  msg,
  fromName,
  toName,
  toStatus,
  onClick,
  selected,
}: MessageCardProps) {
  const undelivered = msg.status === "pending" || msg.status === "seen";
  const deadLetter = undelivered && toStatus && toStatus !== "active";
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-xl border cursor-pointer transition-all ${
        selected
          ? "border-accent bg-accent-soft/50 shadow-sm"
          : "border-line bg-surface hover:border-line-strong hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="text-ink font-medium">
          {fromName ?? msg.from_session.slice(0, 8)}
        </span>
        <ArrowRight size={12} className="text-ink-faint" />
        <span className="text-ink font-medium">{toName ?? msg.to_session.slice(0, 8)}</span>
        {deadLetter && (
          <span
            className="ml-auto px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-red-50 text-red-600 border border-red-200"
            title="目标会话离线:消息未送达,直到该对话被 resume"
          >
            目标离线
          </span>
        )}
        <span
          className={`${deadLetter ? "" : "ml-auto"} px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
            STATUS_COLORS[msg.status] ?? "bg-paper text-ink-muted border border-line"
          }`}
        >
          {msg.status}
        </span>
      </div>
      <div className="text-sm text-ink truncate">
        <InlineMarkdown>{msg.question}</InlineMarkdown>
      </div>
      {msg.reply && (
        <div className="text-xs text-ink-muted truncate mt-1">
          ↳ <InlineMarkdown>{msg.reply}</InlineMarkdown>
        </div>
      )}
    </div>
  );
}
