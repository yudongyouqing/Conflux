import { useState } from "react";
import { useSessionContext, useEdgeMessages, useEdgeAsk, useOpenSessionTerminal } from "../hooks";
import { MentionComposer } from "./MentionComposer";
import type { Message, GraphNode, SessionStatus } from "@muiltchat/shared";
import { StatusDot } from "./StatusDot";
import { FileText, Clock, ArrowRight, FolderOpen, Send, Loader2, ArrowLeftRight, TerminalSquare } from "lucide-react";

const WEB_CONSOLE_ID = "web-console";
const DEFAULT_DESC = "Claude Code session (hook)";

interface DetailPanelProps {
  session: GraphNode | null;
  message: Message | null;
  edge: { id: number; from: string; to: string } | null;
  sessionNameLookup: (id: string) => string | undefined;
  sessionStatusLookup: (id: string) => SessionStatus | undefined;
  /** Open a conversation channel in this panel (发起对话). */
  onOpenEdge: (edge: { id: number; from: string; to: string }) => void;
}

export function DetailPanel({
  session,
  message,
  edge,
  sessionNameLookup,
  sessionStatusLookup,
  onOpenEdge,
}: DetailPanelProps) {
  const { data: contextEntries } = useSessionContext(session?.id ?? null);

  if (session) {
    return (
      <SessionDetail
        session={session}
        contextEntries={contextEntries}
        onOpenEdge={onOpenEdge}
      />
    );
  }

  if (edge) {
    return (
      <EdgeFlowView
        edge={edge}
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
 * Channel (edge) branch: a directed conversation channel. The channel's
 * `from` speaks (questions), its `to` answers — replies stay on this
 * channel. Newest at the top. Only web-console channels can be spoken on
 * from here; third-party channels are read-only.
 */
function EdgeFlowView({
  edge,
  sessionNameLookup,
  sessionStatusLookup,
}: {
  edge: { id: number; from: string; to: string };
  sessionNameLookup: (id: string) => string | undefined;
  sessionStatusLookup: (id: string) => SessionStatus | undefined;
}) {
  const { from, to } = edge;
  const { data } = useEdgeMessages(edge.id);
  const ask = useEdgeAsk();
  const [text, setText] = useState("");
  const messages = (data?.messages ?? []).slice().reverse();
  const nameOf = (id: string) => sessionNameLookup(id) ?? id.slice(0, 8);
  const speakable = from === WEB_CONSOLE_ID;
  const targetOffline = sessionStatusLookup(to) && sessionStatusLookup(to) !== "active";

  const send = () => {
    const question = text.trim();
    if (!question || ask.isPending) return;
    ask.mutate(
      { edgeId: edge.id, question },
      { onSuccess: () => setText("") }
    );
  };

  return (
    <div className="p-5 space-y-4 overflow-y-auto h-full">
      <div>
        <h2 className="text-gray-900 font-semibold text-[15px] flex items-center gap-1.5">
          <ArrowLeftRight size={14} className="text-gray-400" />
          对话通道 #{edge.id}
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
          <span className="text-gray-400">· {messages.length} 条 · 最新在上</span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">
          {nameOf(from)} 发起的通道:{nameOf(from)} 提问,{nameOf(to)} 回答,回复留在本通道。
        </div>
      </div>

      {speakable ? (
        <div>
          {targetOffline && (
            <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mb-1.5">
              ⚠ {nameOf(to)} 当前离线。发送后将自动 headless 唤醒它回复(若可恢复)。
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
              }}
              placeholder={`以 Web 控制台身份在通道 #${edge.id} 发言…`}
              className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300"
            />
            <button
              onClick={send}
              disabled={!text.trim() || ask.isPending}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-40 hover:bg-blue-700 transition-colors flex-shrink-0"
            >
              {ask.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              发送
            </button>
          </div>
          {ask.isError && (
            <p className="text-[10px] text-red-500 mt-1">{(ask.error as Error).message}</p>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5">
          只读通道:由 {nameOf(from)} 发起,只有它能在本通道发问;{nameOf(to)} 的回复会显示在这里。
        </div>
      )}

      {messages.length === 0 ? (
        <p className="text-xs text-gray-400">通道还没有消息。</p>
      ) : (
        <div className="space-y-3">
          {messages.map((m) => {
            const outgoing = m.from_session === from;
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
  onOpenEdge,
}: {
  session: GraphNode;
  contextEntries: ReturnType<typeof useSessionContext>["data"];
  onOpenEdge: (edge: { id: number; from: string; to: string }) => void;
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
          <StatusDot status={session.status} busy={session.busy} />
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

      {isSession && <InitiateConversation session={session} onOpenEdge={onOpenEdge} />}

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
function InitiateConversation({
  session,
  onOpenEdge,
}: {
  session: GraphNode;
  onOpenEdge: (edge: { id: number; from: string; to: string }) => void;
}) {
  return (
    <div>
      <h3 className="text-xs text-gray-500 font-medium mb-2 flex items-center gap-1">
        <ArrowRight size={12} /> 发起对话通道
      </h3>
      {session.status !== "active" && (
        <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mb-2">
          ⚠ 对方当前{session.status === "ended" ? "已结束" : "离线"}。发送后将尝试自动唤醒它回复。
        </div>
      )}
      <MentionComposer
        sender={session.id === WEB_CONSOLE_ID ? null : { id: session.id, name: session.name }}
        onSent={(_t, message) => {
          // jump straight into the channel this question created
          if (message?.edge_id != null) {
            onOpenEdge({
              id: message.edge_id,
              from: message.from_session ?? WEB_CONSOLE_ID,
              to: message.to_session,
            });
          }
        }}
      />
    </div>
  );
}

