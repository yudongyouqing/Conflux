import { useState, useRef, useCallback } from "react";
import { ArrowLeft, Send, Bot, User, Wrench, Loader2 } from "lucide-react";
import { api } from "../api";
import type { Agent } from "../types";

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
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || isStreaming) return;

    setInput("");
    setError(null);
    setMessages((prev) => [
      ...prev,
      { kind: "chat", role: "user", content: message },
      { kind: "chat", role: "assistant", content: "", streaming: true },
    ]);
    setIsStreaming(true);
    let receivedAny = false;

    await api.streamChat(
      agent.id,
      message,
      conversationId,
      (token) => {
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
        setConversationId(data.conversation_id);
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === "chat" && m.role === "assistant" && m.streaming
              ? { ...m, streaming: false }
              : m
          )
        );
      },
      (msg) => {
        setError(msg);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "chat" && last.role === "assistant" && last.streaming && !receivedAny) {
            return prev.slice(0, -1);
          }
          return prev.map((m) =>
            m.kind === "chat" && m.streaming ? { ...m, streaming: false } : m
          );
        });
      },
      (name, toolInput) => {
        setMessages((prev) => [...prev, { kind: "tool", name, input: toolInput, loading: true }]);
        scrollToBottom();
      },
      (name, result) => {
        setMessages((prev) => {
          const idx = [...prev].reverse().findIndex(
            (m) => m.kind === "tool" && m.name === name && m.loading
          );
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
    );

    setIsStreaming(false);
  }, [input, isStreaming, agent.id, conversationId, scrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-100">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 bg-white border-b border-gray-200 flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft size={14} /> 返回
        </button>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Bot size={14} className="text-white" />
          </div>
          <span className="text-sm text-gray-900 font-medium">{agent.name}</span>
        </div>
        <span className="ml-auto text-[10px] px-2 py-1 rounded-md bg-gray-100 text-gray-600 border border-gray-200">
          {agent.model_config.provider}/{agent.model_config.model}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
        <div className="max-w-2xl mx-auto space-y-4">
          {messages.length === 0 && !error && (
            <div className="text-center text-gray-400 text-sm mt-12">
              向 {agent.name} 发送一条消息开始对话
            </div>
          )}
          {messages.map((msg, i) => {
            if (msg.kind === "tool") {
              return <ToolCard key={i} name={msg.name} input={msg.input} result={msg.result} loading={msg.loading} />;
            }
            return <MessageBubble key={i} role={msg.role} content={msg.content} streaming={msg.streaming} />;
          })}
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="p-4 bg-white border-t border-gray-200 flex-shrink-0">
        <div className="max-w-2xl mx-auto flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "等待回复..." : `跟 ${agent.name} 聊天...`}
            disabled={isStreaming}
            rows={1}
            className="flex-1 bg-white text-gray-800 text-sm rounded-xl px-4 py-2.5 border border-gray-200 placeholder-gray-400 outline-none focus:border-blue-500 resize-none disabled:bg-gray-50 disabled:opacity-60 shadow-sm"
            style={{ minHeight: "42px", maxHeight: "120px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="flex items-center justify-center w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-200 disabled:text-gray-400 text-white transition-colors flex-shrink-0 shadow-sm"
          >
            <Send size={16} />
          </button>
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

  if (!content && streaming) {
    return (
      <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
        <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${isUser ? "bg-blue-600" : "bg-gray-200"}`}>
          {isUser ? <User size={13} className="text-white" /> : <Bot size={13} className="text-gray-600" />}
        </div>
        <div className="px-4 py-2.5 rounded-xl bg-white border border-gray-200 shadow-sm">
          <Loader2 size={14} className="text-gray-400 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${isUser ? "bg-blue-600" : "bg-gray-200"}`}>
        {isUser ? <User size={13} className="text-white" /> : <Bot size={13} className="text-gray-600" />}
      </div>
      <div
        className={`max-w-[75%] px-4 py-2.5 rounded-xl text-sm whitespace-pre-wrap shadow-sm ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-white text-gray-800 border border-gray-200"
        }`}
      >
        {content}
        {streaming && (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-gray-400 animate-pulse align-text-bottom" />
        )}
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
  const inputStr = JSON.stringify(input);
  const resultSummary = result
    ? typeof result === "object" && result !== null && Array.isArray(result)
      ? `${result.length} items`
      : typeof result === "object" && result !== null
        ? "✓"
        : String(result).slice(0, 60)
    : null;

  return (
    <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-50/60 border border-amber-200/60 text-xs mx-10">
      <Wrench size={11} className="text-amber-600 flex-shrink-0" />
      <span className="text-gray-700 font-mono font-medium">{name}</span>
      <span className="text-gray-400 truncate">{inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr}</span>
      {loading && <Loader2 size={10} className="animate-spin text-gray-400 flex-shrink-0" />}
      {!loading && resultSummary && (
        <span className="text-emerald-600 flex-shrink-0">{resultSummary}</span>
      )}
    </div>
  );
}
