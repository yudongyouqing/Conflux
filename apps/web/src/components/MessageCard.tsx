import { ArrowRight } from "lucide-react";
import { InlineMarkdown } from "./InlineMarkdown";
import { MessageDeliveryControl } from "./MessageDeliveryControl";
import type { Message } from "@conflux/shared";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-warning-soft text-warning border border-warning/30",
  seen: "bg-info-soft text-info border border-info/30",
  replied: "bg-success-soft text-success border border-success/30",
  read: "bg-neutral-soft text-neutral border border-neutral/30",
};

interface MessageCardProps {
  msg: Message;
  fromName?: string;
  toName?: string;
  /** Graph status of the target session, separate from message read state. */
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
  const deadLetter = msg.status === "pending" && toStatus && toStatus !== "active";
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-xl border cursor-pointer transition-all ${
        selected
          ? "border-accent bg-accent-soft/50 shadow-card"
          : "border-line bg-surface hover:border-line-strong hover:shadow-card"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs mb-1">
        <span className="text-ink font-medium">{fromName ?? msg.from_session.slice(0, 8)}</span>
        <ArrowRight size={12} className="text-ink-faint" />
        <span className="text-ink font-medium">{toName ?? msg.to_session.slice(0, 8)}</span>
        {deadLetter && (
          <span
            className="ml-auto px-1.5 py-0.5 rounded-md text-2xs font-medium bg-neutral-soft text-neutral border border-neutral/30"
            title="目标会话当前离线，消息尚未被读取；唤醒结果单独显示"
          >
            目标离线
          </span>
        )}
        <span
          className={`${deadLetter ? "" : "ml-auto"} px-1.5 py-0.5 rounded-md text-2xs font-medium ${
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
      <MessageDeliveryControl message={msg} />
    </div>
  );
}
