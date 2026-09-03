import { useMemo, useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessions } from "../hooks";
import { api } from "../api";
import { StatusDot } from "./StatusDot";
import type { Message, SessionStatus } from "@muiltchat/shared";

/** Minimal session identity the composer needs (GraphNode and SessionSummary both satisfy it). */
export interface ComposerTarget {
  id: string;
  name: string;
  status: SessionStatus;
  busy?: boolean;
}

function targetBadge(s: ComposerTarget): { text: string; color: string } {
  if (s.status !== "active") return { text: "离线 · 异步投递", color: "text-gray-400" };
  if (s.busy) return { text: "在线 · 正在回复", color: "text-amber-600" };
  return { text: "在线", color: "text-emerald-600" };
}

interface MentionComposerProps {
  /** Called after a successful ask with the created message (edge jump etc). */
  onSent?: (target: ComposerTarget, message: Message | null) => void;
  className?: string;
}

/**
 * @-mention ask box: pick an active CLI session by typing @ (ASCII or
 * fullwidth), then ask it a question as the web console.
 */
export function MentionComposer({ onSent, className }: MentionComposerProps) {
  const sessions = useSessions("active");
  const queryClient = useQueryClient();

  const [text, setText] = useState("");
  const [target, setTarget] = useState<ComposerTarget | null>(null);
  const [needTarget, setNeedTarget] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // typing "@..." → mention picker; a new @ REPLACES the current target,
  // so a send can never carry zero or multiple mentions
  const mentionQuery = useMemo(() => {
    const m = /[@＠]([^\s@＠]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

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
    onSuccess: (data, vars) => {
      const sent = target;
      const message = (data as { message?: Message } | undefined)?.message ?? null;
      setText("");
      setTarget(null);
      inputRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: ["peer-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["graph"] });
      if (sent) onSent?.(sent, message);
      void vars;
    },
  });

  const pickTarget = (s: ComposerTarget) => {
    setTarget(s);
    setText((t) => t.replace(/[@＠]([^\s@＠]*)$/, ""));
    inputRef.current?.focus();
  };

  const send = () => {
    const question = text.trim();
    if (ask.isPending) return;
    if (!target) {
      setNeedTarget(true); // zero mentions — reject with a visible hint
      setTimeout(() => setNeedTarget(false), 2500);
      return;
    }
    if (!question) return;
    ask.mutate({ to_session: target.id, question });
  };

  return (
    <div className={`p-3 bg-white border border-gray-200 rounded-lg shadow-sm ${className ?? ""}`}>
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
      {needTarget && (
        <div className="text-xs text-amber-600 mt-1">请先 @ 选择一个目标会话（每次对话只能有一个目标）</div>
      )}
      {ask.isError && (
        <div className="text-xs text-red-500 mt-1">发送失败: {(ask.error as Error).message}</div>
      )}
    </div>
  );
}
