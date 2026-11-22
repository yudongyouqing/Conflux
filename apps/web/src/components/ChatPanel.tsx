import { useSmoothText } from "../use-smooth-text";
import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowLeft, Send, Bot, User, Wrench, Loader2, Plus } from "lucide-react";
import { api } from "../api";
import { MarkdownText } from "./MarkdownText";
import type { Agent } from "@conflux/shared";

interface ChatPanelProps {
  agent: Agent;
  onBack: () => void;
}

type DisplayMessage =
  | { kind: "chat"; role: "user" | "assistant"; content: string; streaming?: boolean }
  | { kind: "tool"; name: string; input: unknown; result?: unknown; loading: boolean };

export function ChatPanel({ agent, onBack }: ChatPanelProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = controller;
    streamRef.current?.abort();
    streamRef.current = null;
    setMessages([]);
    setConversationId(null);
    setError(null);
    setIsStreaming(false);
    setLoadingHistory(true);

    api
      .getConversations(agent.id, controller.signal)
      .then(async ({ conversations }) => {
        if (controller.signal.aborted) return;
        const latest = conversations[0];
        if (!latest) return;
        const { turns } = await api.getTurns(latest.id, controller.signal);
        if (controller.signal.aborted) return;
        setConversationId(latest.id);
        setMessages(
          turns
            .filter((t): t is typeof t & { role: "user" | "assistant" } =>
              t.role === "user" || t.role === "assistant",
            )
            .map((t) => ({ kind: "chat" as const, role: t.role, content: t.content })),
        );
        scrollToBottom();
      })
      .catch(() => {
        // Fresh chat still works even if history lookup fails or is aborted
      })
      .finally(() => {
        if (historyAbortRef.current === controller) historyAbortRef.current = null;
        if (!controller.signal.aborted) setLoadingHistory(false);
      });

    return () => {
      controller.abort();
      if (historyAbortRef.current === controller) historyAbortRef.current = null;
      streamRef.current?.abort();
    };
  }, [agent.id, scrollToBottom]);

  const handleNewChat = useCallback(() => {
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    streamRef.current?.abort();
    streamRef.current = null;
    setLoadingHistory(false);
    setIsStreaming(false);
    setConversationId(null);
    setMessages([]);
    setError(null);
  }, []);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || isStreaming || streamRef.current) return;
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    setLoadingHistory(false);
    const controller = new AbortController();
    streamRef.current = controller;

    setInput("");
    setError(null);
    setMessages((prev) => [
      ...prev,
      { kind: "chat", role: "user", content: message },
      { kind: "chat", role: "assistant", content: "", streaming: true },
    ]);
    setIsStreaming(true);
    let receivedAny = false;

    try {
    await api.streamChat(
      agent.id,
      message,
      conversationId,
      (token) => {
        if (controller.signal.aborted) return;
        receivedAny = true;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "chat" && last.role === "assistant" && last.streaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + token }];
          }
          return [...prev, { kind: "chat", role: "assistant", content: token, streaming: true }];
        });
        scrollToBottom();
      },
      (data) => {
        if (controller.signal.aborted) return;
        setConversationId(data.conversation_id);
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === "chat" && m.role === "assistant" && m.streaming
              ? { ...m, streaming: false }
              : m,
          ),
        );
      },
      (msg) => {
        if (controller.signal.aborted) return;
        setError(msg);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (
            last &&
            last.kind === "chat" &&
            last.role === "assistant" &&
            last.streaming &&
            !receivedAny
          ) {
            return prev.slice(0, -1);
          }
          return prev.map((m) =>
            m.kind === "chat" && m.streaming ? { ...m, streaming: false } : m,
          );
        });
      },
      (name, toolInput) => {
        if (controller.signal.aborted) return;
        setMessages((prev) => [...prev, { kind: "tool", name, input: toolInput, loading: true }]);
        scrollToBottom();
      },
      (name, result) => {
        if (controller.signal.aborted) return;
        setMessages((prev) => {
          const idx = [...prev]
            .reverse()
            .findIndex((m) => m.kind === "tool" && m.name === name && m.loading);
          if (idx === -1) return prev;
          const realIdx = prev.length - 1 - idx;
          const target = prev[realIdx] as Extract<DisplayMessage, { kind: "tool" }>;
          return [
            ...prev.slice(0, realIdx),
            { ...target, result, loading: false },
            ...prev.slice(realIdx + 1),
          ];
        });
        scrollToBottom();
      },
      controller.signal,
    );
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (streamRef.current === controller) streamRef.current = null;
      if (!controller.signal.aborted) {
        setIsStreaming(false);
        setMessages((prev) => prev.flatMap((m): DisplayMessage[] => {
          if (m.kind === "chat" && m.streaming) return m.content ? [{ ...m, streaming: false }] : [];
          if (m.kind === "tool" && m.loading) return [{ ...m, loading: false }];
          return [m];
        }));
      }
    }
  }, [input, isStreaming, agent.id, conversationId, scrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-12 bg-surface border-b border-line/80 flex-shrink-0">
        <button
          type="button"
          onClick={() => { streamRef.current?.abort(); onBack(); }}
          className="flex items-center gap-1 text-xs text-ink-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={14} /> 返回
        </button>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-accent-soft text-accent flex items-center justify-center">
            <Bot size={13} />
          </div>
          <span className="text-sm text-ink font-semibold tracking-[-0.015em]">{agent.name}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleNewChat}
            disabled={
              !isStreaming && !loadingHistory && messages.length === 0 && conversationId === null && !error
            }
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-2xs text-ink-muted hover:text-ink hover:bg-tile-hover border border-line transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="开启新对话"
          >
            <Plus size={12} /> 新对话
          </button>
          <span className="text-2xs font-mono px-2 py-1 rounded-md bg-paper text-ink-muted border border-line/80">
            {agent.model_config.provider}/{agent.model_config.model}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {loadingHistory && messages.length === 0 && (
            <div className="text-center text-ink-faint text-sm mt-12">
              <Loader2 size={14} className="inline-block animate-spin mr-1.5" />
              加载历史对话…
            </div>
          )}
          {!loadingHistory && messages.length === 0 && !error && (
            <div className="text-center text-ink-faint text-sm mt-12">
              向 {agent.name} 发送一条消息开始对话
            </div>
          )}
          {messages.map((msg, i) => {
            if (msg.kind === "tool") {
              return (
                <ToolCard
                  key={i}
                  name={msg.name}
                  input={msg.input}
                  result={msg.result}
                  loading={msg.loading}
                />
              );
            }
            return (
              <MessageBubble
                key={i}
                role={msg.role}
                content={msg.content}
                streaming={msg.streaming}
              />
            );
          })}
          {error && (
            <div className="text-xs text-danger bg-danger-soft border border-danger/30 rounded-xl p-3">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Linear-style floating docked composer */}
      <div className="px-4 pb-4 pt-2 flex-shrink-0">
        <div className="max-w-3xl mx-auto rounded-xl border border-line bg-surface shadow-card focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 transition-all">
          <div className="px-3.5 pt-2.5 pb-1.5">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? "等待回复..." : `跟 ${agent.name} 聊天…（Enter 发送，Shift+Enter 换行）`}
              disabled={isStreaming}
              rows={2}
              className="w-full bg-transparent text-ink text-md-plus placeholder-ink-faint outline-none resize-none disabled:opacity-60 leading-relaxed"
              style={{ maxHeight: "140px" }}
            />
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-line/60">
            <span className="text-2xs text-ink-faint">Enter 发送 · Shift+Enter 换行</span>
            <button
              type="button"
              aria-label="发送消息"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-deep disabled:opacity-40 text-on-accent text-xs font-medium transition-colors flex-shrink-0"
            >
              <Send size={12} /> 发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  // streaming assistant text runs through the typewriter pacer
  const paced = useSmoothText(content, { active: !!streaming && !isUser });

  if (!content && streaming) {
    return (
      <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
        <div
          className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${isUser ? "bg-accent" : "bg-line"}`}
        >
          {isUser ? (
            <User size={13} className="text-on-accent" />
          ) : (
            <Bot size={13} className="text-ink-muted" />
          )}
        </div>
        <div className="px-4 py-2.5 rounded-xl bg-surface border border-line shadow-card">
          <Loader2 size={14} className="text-ink-faint animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${isUser ? "bg-accent" : "bg-line"}`}
      >
        {isUser ? (
          <User size={13} className="text-on-accent" />
        ) : (
          <Bot size={13} className="text-ink-muted" />
        )}
      </div>
      <div
        className={`max-w-[75%] px-4 py-2.5 rounded-xl shadow-card ${
          isUser ? "bg-accent text-on-accent" : "bg-surface text-ink border border-line"
        }`}
      >
        <MarkdownText tone={isUser ? "blue" : "light"}>{paced}</MarkdownText>
        {streaming && paced.length < content.length && <span className="smooth-caret" />}
      </div>
    </div>
  );
}

function ToolCard({
  name,
  input,
  result,
  loading,
}: {
  name: string;
  input: unknown;
  result?: unknown;
  loading: boolean;
}) {
  const inputStr = JSON.stringify(input) ?? "";
  const hasResult = result !== undefined && result !== null;
  const resultSummary = hasResult
    ? Array.isArray(result)
      ? `${result.length} items`
      : typeof result === "object"
        ? "✓"
        : String(result).slice(0, 60)
    : null;

  return (
    <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-warning-soft/60 border border-warning/30 text-xs mx-10">
      <Wrench size={11} className="text-warning flex-shrink-0" />
      <span className="text-ink font-mono font-medium">{name}</span>
      <span className="text-ink-faint truncate">
        {inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr}
      </span>
      {loading && <Loader2 size={10} className="animate-spin text-ink-faint flex-shrink-0" />}
      {!loading && resultSummary !== null && (
        <span className="text-success flex-shrink-0">{resultSummary}</span>
      )}
    </div>
  );
}
