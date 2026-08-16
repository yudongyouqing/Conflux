import { useState } from "react";
import { useSessionContext, usePeerMessages, useWebAsk, usePeerFlow, useOpenSessionTerminal } from "../hooks";
import type { Message, GraphNode, SessionStatus } from "@muiltchat/shared";
import { StatusDot } from "./StatusDot";
import { FileText, Clock, ArrowRight, FolderOpen, Send, Loader2, ArrowLeftRight, TerminalSquare } from "lucide-react";

const WEB_CONSOLE_ID = "web-console";
const DEFAULT_DESC = "Claude Code session (hook)";

interface DetailPanelProps {
  session: GraphNode | null;
  message: Message | null;
  edge: { from: string; to: string } | null;
  sessionNameLookup: (id: string) => string | undefined;
  sessionStatusLookup: (id: string) => SessionStatus | undefined;
}

export function DetailPanel({
  session,
  message,
  edge,
  sessionNameLookup,
  sessionStatusLookup,
}: DetailPanelProps) {
  const { data: contextEntries } = useSessionContext(session?.id ?? null);

  if (session) {
    return <SessionDetail session={session} contextEntries={contextEntries} />;
  }

  if (edge) {
    return (
      <EdgeFlowView
        from={edge.from}
        to={edge.to}
        sessionNameLookup={sessionNameLookup}
        sessionStatusLookup={sessionStatusLookup}
      />
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
            {sessionNameLookup(message.to_session) ?? message.to_session.slice(0, 8)}
          </span>
          <span
            className={`ml-auto px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
              message.status === "pending"
                ? "bg-amber-50 text-amber-700 border border-amber-200"
                : message.status === "seen"
                  ? "bg-violet-50 text-violet-700 border border-violet-200"
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
              {message.replied_at && ` · ${new Date(message.replied_at).toLocaleString()}`}
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

/**
 * Edge branch: the two-way message flow carried by a graph edge.
 * Newest at the top, history below. Outgoing (from → to) bubbles right;
 * incoming left; pending highlighted.
 */
function EdgeFlowView({
  from,
  to,
  sessionNameLookup,
  sessionStatusLookup,
}: {
  from: string;
  to: string;
  sessionNameLookup: (id: string) => string | undefined;
  sessionStatusLookup: (id: string) => SessionStatus | undefined;
}) {
  const { data } = usePeerFlow(from, to);
  const ask = useWebAsk();
  const [text, setText] = useState("");
  // Which side of the pair the web console addresses. Default to the side
  // that isn't the console itself; if neither is, the "to" side wins.
  const [target, setTarget] = useState<"from" | "to">(
    to === WEB_CONSOLE_ID ? "from" : "to"
  );
  // listPeerMessages returns oldest-first; the panel reads newest-first.
  const messages = (data?.messages ?? []).slice().reverse();
  const nameOf = (id: string) => sessionNameLookup(id) ?? id.slice(0, 8);
  const targetId = target === "from" ? from : to;
  // Whose perspective the bubble sides represent (see alignment note below).
  const anchor =
    from === WEB_CONSOLE_ID || to === WEB_CONSOLE_ID ? WEB_CONSOLE_ID : from;

  const send = () => {
    const question = text.trim();
    if (!question || ask.isPending) return;
    ask.mutate(
      { to_session: targetId, question },
      { onSuccess: () => setText("") }
    );
  };

  return (
    <div className="p-5 space-y-4 overflow-y-auto h-full">
      <div>
        <h2 className="text-gray-900 font-semibold text-[15px] flex items-center gap-1.5">
          <ArrowLeftRight size={14} className="text-gray-400" />
          对话流
        </h2>
        <div className="text-xs text-gray-600 mt-1 flex items-center gap-1.5 flex-wrap">
          <span className="font-medium flex items-center gap-1">
            <StatusDot status={sessionStatusLookup(from) ?? "stale"} />
            {nameOf(from)}
          </span>
          <ArrowRight size={11} className="text-gray-400" />
          <span className="font-medium flex items-center gap-1">
            <StatusDot status={sessionStatusLookup(to) ?? "stale"} />
            {nameOf(to)}
          </span>
          <span className="text-gray-400">
            · {messages.length} 条 · 最新在上
          </span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">
          每条消息标注自身方向;右侧(蓝色)= {nameOf(anchor)} 发出
          {anchor !== WEB_CONSOLE_ID && "(第三方对话,以通道起点为观察位)"}
        </div>
      </div>

      {/* Join the conversation as the web console: the picker mirrors the
          channel direction (from → to); asking always creates a NEW question
          from the console to the chosen side. */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          <span className="text-[10px] text-gray-400 flex-shrink-0">问:</span>
          {(["from", "to"] as const).map((side, idx) => {
            const id = side === "from" ? from : to;
            const isSelf = id === WEB_CONSOLE_ID;
            const selected = target === side;
            return (
              <span key={side} className="flex items-center gap-1.5">
                {idx === 1 && (
                  <ArrowRight size={11} className="text-gray-400" aria-label="方向" />
                )}
                <button
                  onClick={() => !isSelf && setTarget(side)}
                  disabled={isSelf}
                  className={`px-2 py-0.5 rounded-md text-[10px] border transition-colors truncate max-w-[140px] ${
                    isSelf
                      ? "bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed"
                      : selected
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-600 border-gray-200 hover:border-blue-300"
                  }`}
                  title={isSelf ? "Web 控制台不能问自己" : id}
                >
                  问 {nameOf(id)}
                </button>
              </span>
            );
          })}
        </div>
        <div className="text-[10px] text-gray-400 mb-1.5">
          通道方向:{nameOf(from)} → {nameOf(to)} · 你将以 Web 控制台身份向{" "}
          {nameOf(targetId)} 发起新提问
        </div>
        {sessionStatusLookup(targetId) && sessionStatusLookup(targetId) !== "active" && (
          <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mb-1.5">
            ⚠ 目标 {nameOf(targetId)} 当前离线(心跳超时)。消息仍会投递,但要等它被唤醒才会处理;若该会话已被清理,发送会失败并在此提示。
          </div>
        )}
        <div className="flex gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
            }}
            placeholder={`以 Web 控制台身份问 ${nameOf(targetId)}…`}
            className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300"
          />
          <button
            onClick={send}
            disabled={!text.trim() || ask.isPending}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-40 hover:bg-blue-700 transition-colors flex-shrink-0"
          >
            {ask.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Send size={12} />
            )}
            发送
          </button>
        </div>
        {ask.isError && (
          <p className="text-[10px] text-red-500 mt-1">
            {(ask.error as Error).message}
          </p>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="text-xs text-gray-400">这对会话之间还没有消息。</p>
      ) : (
        <div className="space-y-3">
          {messages.map((m) => {
            // Identity-anchored alignment: when the console is one of the
            // endpoints, its messages are always "outgoing" (right/blue) —
            // the same perspective as the session drawer — no matter which
            // direction of edge was clicked. For third-party pairs neither
            // side is "us", so fall back to the clicked edge's source.
            const outgoing = m.from_session === anchor;
            return (
              <div
                key={m.id}
                className={`flex flex-col ${outgoing ? "items-end" : "items-start"}`}
              >
                <div className="text-[10px] text-gray-400 mb-0.5">
                  {nameOf(m.from_session)} → {nameOf(m.to_session)} ·{" "}
                  {new Date(m.created_at).toLocaleString()}
                </div>
                <div
                  className={`text-sm whitespace-pre-wrap p-2.5 rounded-xl border max-w-[95%] ${
                    outgoing
                      ? "bg-blue-50 border-blue-200 text-gray-800"
                      : "bg-gray-50 border-gray-200 text-gray-800"
                  }`}
                >
                  {m.question}
                </div>
                {m.status === "pending" ? (
                  <div className="text-[10px] text-amber-600 mt-0.5">等待回复…</div>
                ) : m.reply ? (
                  <div className="text-sm whitespace-pre-wrap p-2.5 rounded-xl border bg-emerald-50 border-emerald-200 text-emerald-800 max-w-[95%] mt-1">
                    ↩ {m.reply}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Session branch: identity + activity + context + web-console conversation. */
function SessionDetail({
  session,
  contextEntries,
}: {
  session: GraphNode;
  contextEntries: ReturnType<typeof useSessionContext>["data"];
}) {
  const isSession = session.type === "session";
  const openTerminal = useOpenSessionTerminal();
  const [openNote, setOpenNote] = useState<string | null>(null);
  const activity =
    session.description && session.description !== DEFAULT_DESC
      ? session.description
      : null;

  const handleOpenTerminal = () => {
    setOpenNote(null);
    openTerminal.mutate(session.id, {
      onSuccess: (r) => setOpenNote(`已在 ${r.opener} 打开`),
      onError: (e) => setOpenNote(`打开失败: ${(e as Error).message}`),
    });
  };

  return (
    <div className="p-5 space-y-5 overflow-y-auto h-full">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <StatusDot status={session.status} />
          <h2 className="text-gray-900 font-semibold text-[15px] break-all">
            {session.name}
          </h2>
        </div>
        {activity && (
          <div className="text-xs text-blue-600 bg-blue-50 border border-blue-100 rounded-lg px-2 py-1 mb-1.5 truncate" title={activity}>
            正在: {activity}
          </div>
        )}
        <div className="text-[10px] text-gray-400 font-mono break-all">
          {session.id}
        </div>
        {session.project_dir && (
          <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1 min-w-0" title={session.project_dir}>
            <FolderOpen size={11} className="flex-shrink-0" />
            <span className="truncate">{session.project_dir}</span>
          </div>
        )}
        {session.skills && session.skills.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-1.5">
            {session.skills.map((s) => (
              <span
                key={s}
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-cyan-50 text-cyan-700 border border-cyan-200"
                title="Agent Card 技能"
              >
                {s}
              </span>
            ))}
          </div>
        )}
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

      {isSession && (
        <div>
          <button
            onClick={handleOpenTerminal}
            disabled={openTerminal.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
            title="在新终端窗口 resume 这个对话"
          >
            {openTerminal.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <TerminalSquare size={13} />
            )}
            在终端打开
          </button>
          {openNote && <div className="text-[11px] text-gray-500 mt-1.5">{openNote}</div>}
        </div>
      )}

      {isSession && <ConversationBox sessionId={session.id} status={session.status} />}

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

/** Ask/message flow between the web console and one session. */
function ConversationBox({ sessionId, status }: { sessionId: string; status: SessionStatus }) {
  const { data } = usePeerMessages(sessionId);
  const ask = useWebAsk();
  const [text, setText] = useState("");
  const messages = data?.messages ?? [];

  const send = () => {
    const question = text.trim();
    if (!question || ask.isPending) return;
    ask.mutate(
      { to_session: sessionId, question },
      { onSuccess: () => setText("") }
    );
  };

  return (
    <div>
      <h3 className="text-xs text-gray-500 font-medium mb-2 flex items-center gap-1">
        <ArrowRight size={12} /> 对话(以 Web 控制台身份)
      </h3>

      {status !== "active" && (
        <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mb-2">
          ⚠ 对方当前{status === "ended" ? "已结束" : "离线(心跳超时)"}。消息仍会投递,但要等它被唤醒(终端里打开/resume)才会处理;若已被清理,发送会失败并提示。
        </div>
      )}

      {messages.length === 0 ? (
        <p className="text-xs text-gray-400 mb-2">还没有消息,发一条试试。</p>
      ) : (
        <div className="space-y-2 mb-2 max-h-64 overflow-y-auto">
          {messages.map((m) => {
            const outgoing = m.from_session === WEB_CONSOLE_ID;
            return (
              <div key={m.id} className={`flex ${outgoing ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-xl px-2.5 py-1.5 border text-xs ${
                    outgoing
                      ? "bg-blue-50 border-blue-100 text-gray-800"
                      : "bg-gray-50 border-gray-200 text-gray-800"
                  }`}
                >
                  <div className="whitespace-pre-wrap break-words">{m.question}</div>
                  {m.reply ? (
                    <div className="mt-1 pt-1 border-t border-gray-200/70 text-emerald-700 whitespace-pre-wrap break-words">
                      ↩ {m.reply}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[10px] text-amber-600">等待回复…</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
          }}
          placeholder="问这个会话…"
          className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300"
        />
        <button
          onClick={send}
          disabled={!text.trim() || ask.isPending}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-40 hover:bg-blue-700 transition-colors flex-shrink-0"
        >
          {ask.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Send size={12} />
          )}
          发送
        </button>
      </div>
      {ask.isError && (
        <p className="text-[10px] text-red-500 mt-1">{(ask.error as Error).message}</p>
      )}
    </div>
  );
}
