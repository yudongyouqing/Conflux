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
      // onToken
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
      // onDone
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
      // onError
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
      // onToolUse
      (name, toolInput) => {
        setMessages((prev) => [...prev, { kind: "tool", name, input: toolInput, loading: true }]);
        scrollToBottom();
      },
      // onToolResult
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
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ArrowLeft size={14} /> 返回
        </button>
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-blue-400" />
          <span className="text-sm text-slate-200 font-medium">{agent.name}</span>
        </div>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
          {agent.model_config.provider}/{agent.model_config.model}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !error && (
          <div className="text-center text-slate-600 text-sm mt-8">
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
          <div className="text-xs text-red-400 bg-red-950/30 border border-red-800/40 rounded p-2">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-slate-700 flex-shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "等待回复..." : `跟 ${agent.name} 聊天...`}
            disabled={isStreaming}
            rows={1}
            className="flex-1 bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 placeholder-slate-500 outline-none focus:border-blue-500 resize-none disabled:opacity-50"
            style={{ minHeight: "38px", maxHeight: "120px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors flex-shrink-0"
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
      <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
        <div className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center ${isUser ? "bg-blue-600" : "bg-slate-700"}`}>
          {isUser ? <User size={12} className="text-white" /> : <Bot size={12} className="text-blue-300" />}
        </div>
        <div className="px-3 py-2 rounded-lg bg-slate-800">
          <Loader2 size={14} className="text-slate-500 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center ${isUser ? "bg-blue-600" : "bg-slate-700"}`}>
        {isUser ? <User size={12} className="text-white" /> : <Bot size={12} className="text-blue-300" />}
      </div>
      <div
        className={`max-w-[75%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
          isUser ? "bg-blue-600/20 text-blue-100" : "bg-slate-800 text-slate-200"
        }`}
      >
        {content}
        {streaming && (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-slate-400 animate-pulse align-text-bottom" />
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
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/30 border border-slate-700/50 text-xs mx-8">
      <Wrench size={11} className="text-amber-400 flex-shrink-0" />
      <span className="text-slate-300 font-mono font-medium">{name}</span>
      <span className="text-slate-600 truncate">{inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr}</span>
      {loading && <Loader2 size={10} className="animate-spin text-slate-500 flex-shrink-0" />}
      {!loading && resultSummary && (
        <span className="text-green-400/70 flex-shrink-0">{resultSummary}</span>
      )}
    </div>
  );
}
