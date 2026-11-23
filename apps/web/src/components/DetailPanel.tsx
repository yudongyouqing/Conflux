import { useState } from "react";
import {
  useSessionContext,
  useEdgeMessages,
  useEdgeAsk,
  useOpenSessionTerminal,
  useRuntimeInstances,
  useSessions,
  useHandoffContext,
} from "../hooks";
import { MentionComposer } from "./MentionComposer";
import { ManagedSessionPanel } from "./ManagedCodexPanel";
import {
  PLACEHOLDER_DESCRIPTIONS,
  WEB_CONSOLE_ID,
  type GraphNode,
  type SessionStatus,
} from "@conflux/shared";
import { StatusDot } from "./StatusDot";
import { useWakeStream } from "../use-wake-stream";
import { MarkdownText } from "./MarkdownText";
import {
  FileText,
  ArrowRight,
  FolderOpen,
  Send,
  Loader2,
  ArrowLeftRight,
  TerminalSquare,
  MousePointerClick,
  Share2,
} from "lucide-react";

interface DetailPanelProps {
  session: GraphNode | null;
  edge: { id: number; from: string; to: string } | null;
  sessionNameLookup: (id: string) => string | undefined;
  sessionStatusLookup: (id: string) => SessionStatus | undefined;
  /** Open a conversation channel in this panel (发起对话). */
  onOpenEdge: (edge: { id: number; from: string; to: string }) => void;
}

export function DetailPanel({
  session,
  edge,
  sessionNameLookup,
  sessionStatusLookup,
  onOpenEdge,
}: DetailPanelProps) {
  const { data: contextEntries } = useSessionContext(session?.id ?? null);

  if (session) {
    return (
      <SessionDetail
        key={session.id}
        session={session}
        contextEntries={contextEntries}
        onOpenEdge={onOpenEdge}
      />
    );
  }

  if (edge) {
    return (
      <EdgeFlowView
        key={edge.id}
        edge={edge}
        sessionNameLookup={sessionNameLookup}
        sessionStatusLookup={sessionStatusLookup}
      />
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="text-center max-w-[220px]">
        <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-paper border border-line flex items-center justify-center">
          <MousePointerClick size={20} className="text-ink-faint" />
        </div>
        <div className="text-sm text-ink-muted font-medium">选择一个对象查看详情</div>
        <div className="text-xs text-ink-faint mt-1">
          点击图节点或图谱连线，详情会显示在这里
        </div>
      </div>
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
  // every channel is speakable — the UI continues it on the initiator's behalf
  const targetOffline = sessionStatusLookup(to) && sessionStatusLookup(to) !== "active";
  // tail the target's wake log live while the panel is open
  const wake = useWakeStream(to);

  const send = () => {
    const question = text.trim();
    if (!question || ask.isPending) return;
    ask.mutate({ edgeId: edge.id, question }, { onSuccess: () => setText("") });
  };

  return (
    <div className="p-5 space-y-4 overflow-y-auto h-full">
      <div>
        <h2 className="text-ink font-semibold text-base-plus flex items-center gap-1.5">
          <ArrowLeftRight size={14} className="text-ink-faint" />
          对话通道 #{edge.id}
        </h2>
        <div className="text-xs text-ink-muted mt-1 flex items-center gap-1.5 flex-wrap">
          <span className="font-medium flex items-center gap-1">
            <StatusDot status={sessionStatusLookup(from) ?? "stale"} />
            {nameOf(from)}
          </span>
          <ArrowRight size={11} className="text-ink-faint" />
          <span className="font-medium flex items-center gap-1">
            <StatusDot status={sessionStatusLookup(to) ?? "stale"} />
            {nameOf(to)}
          </span>
          <span className="text-ink-faint">· {messages.length} 条 · 最新在上</span>
        </div>
        <div className="text-2xs text-ink-faint mt-0.5">
          {nameOf(from)} 发起的通道:{nameOf(from)} 提问,{nameOf(to)} 回复,回复留在本通道。
        </div>
        {(wake.live || wake.text) && (
          <div className="mt-2 rounded-lg border border-line bg-tile px-3 py-2">
            <div className="flex items-center gap-1.5 text-2xs text-ink-muted mb-1">
              {wake.live ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                  唤醒直播中 · {nameOf(to)} 的无头运行 stdout
                </>
              ) : (
                <>上次唤醒输出</>
              )}
            </div>
            <pre className="text-2xs text-ink-muted whitespace-pre-wrap break-all max-h-32 overflow-y-auto font-mono">
              {wake.text || "(等待输出…)"}
            </pre>
          </div>
        )}
      </div>

      <div>
        {targetOffline && (
          <div className="text-2xs text-warning bg-warning-soft border border-warning/30 rounded-md px-2 py-1 mb-1.5">
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
            placeholder={`以 ${nameOf(from)} 身份在通道 #${edge.id} 发言…`}
            className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          />
          <button
            onClick={send}
            disabled={!text.trim() || ask.isPending}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium disabled:opacity-40 hover:bg-accent-deep transition-colors flex-shrink-0"
          >
            {ask.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            发送
          </button>
        </div>
        {ask.isError && (
          <p className="text-2xs text-danger mt-1">{(ask.error as Error).message}</p>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="text-xs text-ink-faint">通道还没有消息。</p>
      ) : (
        <div className="space-y-3">
          {messages.map((m) => {
            const outgoing = m.from_session === from;
            return (
              <div key={m.id} className={`flex flex-col ${outgoing ? "items-end" : "items-start"}`}>
                <div className="text-2xs text-ink-faint mb-0.5">
                  {nameOf(m.from_session)} → {nameOf(m.to_session)} ·{" "}
                  {new Date(m.created_at).toLocaleString()}
                </div>
                <div
                  className={`p-3 rounded-2xl border max-w-[95%] shadow-card ${
                    outgoing
                      ? "bg-accent border-accent text-on-accent"
                      : "bg-surface border-line text-ink"
                  }`}
                >
                  <MarkdownText tone={outgoing ? "blue" : "light"}>{m.question}</MarkdownText>
                </div>
                {m.status === "pending" ? (
                  <div className="text-2xs text-warning mt-0.5">等待回复…</div>
                ) : m.reply ? (
                  <div className="p-3 rounded-2xl border bg-surface border-success/30 text-ink max-w-[95%] mt-1 shadow-card relative">
                    <div className="absolute -top-2 left-3 text-2xs font-semibold text-success bg-success-soft border border-success/30 rounded-full px-1.5">
                      回复
                    </div>
                    <MarkdownText>{m.reply}</MarkdownText>
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

/** Session branch: identity + managed live console + handoff + context + conversation. */
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
  const instancesQuery = useRuntimeInstances(isSession);
  const sessionsQuery = useSessions("all");
  const handoffMutation = useHandoffContext();
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"overview" | "managed" | "handoff">("overview");
  const [handoffTarget, setHandoffTarget] = useState("");
  const [handoffPrompt, setHandoffPrompt] = useState("");
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);

  const managedInstance = (instancesQuery.data?.instances ?? []).find(
    (inst) => inst.session_id === session.id,
  );
  const peerCandidates = (sessionsQuery.data?.sessions ?? []).filter(
    (s) => s.id !== session.id && s.id !== WEB_CONSOLE_ID,
  );

  const activity =
    session.description &&
    !(PLACEHOLDER_DESCRIPTIONS as readonly string[]).includes(session.description)
      ? session.description
      : null;

  const handleOpenTerminal = () => {
    setOpenNote(null);
    openTerminal.mutate(session.id, {
      onSuccess: (r) => setOpenNote(`已在 ${r.opener} 打开`),
      onError: (e) => setOpenNote(`打开失败: ${(e as Error).message}`),
    });
  };

  const handleHandoff = () => {
    if (!handoffTarget || handoffMutation.isPending) return;
    setHandoffNotice(null);
    handoffMutation.mutate(
      {
        from_session: session.id,
        to_session: handoffTarget,
        room_id: session.chat_room_id ?? null,
        prompt: handoffPrompt.trim() || undefined,
      },
      {
        onSuccess: (r) => {
          setHandoffPrompt("");
          setHandoffNotice(`已生成交接上下文 #${r.context_entry.id}（${r.summary_chars} 字符）并投递`);
        },
        onError: (e) => setHandoffNotice(`交接失败：${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="p-5 space-y-4 overflow-y-auto h-full">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <StatusDot status={session.status} busy={session.busy} />
          <h2 className="text-ink font-semibold text-base-plus break-all">{session.name}</h2>
        </div>
        {isSession && (
          <div className="flex bg-tile p-0.5 border border-line/70 rounded-lg text-2xs mb-2.5 w-fit">
            {(
              [
                { id: "overview", label: "概览" },
                ...(managedInstance ? [{ id: "managed", label: "受管执行" }] : []),
                { id: "handoff", label: "一键交接" },
              ] as Array<{ id: "overview" | "managed" | "handoff"; label: string }>
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSubTab(t.id)}
                className={`px-2.5 py-0.5 rounded-md font-medium transition-colors ${
                  subTab === t.id
                    ? "bg-surface text-ink shadow-card"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {activity && (
          <div
            className="text-xs text-accent bg-accent-soft border border-accent/20 rounded-lg px-2 py-1 mb-1.5 truncate"
            title={activity}
          >
            正在: {activity}
          </div>
        )}
        <div className="text-2xs text-ink-faint font-mono break-all">{session.id}</div>
        {session.project_dir && (
          <div
            className="text-2xs text-ink-muted mt-1 flex items-center gap-1 min-w-0"
            title={session.project_dir}
          >
            <FolderOpen size={11} className="flex-shrink-0" />
            <span className="truncate">{session.project_dir}</span>
          </div>
        )}
        {session.skills && session.skills.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-1.5">
            {session.skills.map((s) => (
              <span
                key={s}
                className="text-2xs px-1.5 py-0.5 rounded-md bg-info-soft text-info border border-info/20"
                title="Agent Card 技能"
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </div>

      {subTab === "managed" && managedInstance ? (
        <ManagedSessionPanel
          instanceId={managedInstance.id}
          instanceName={session.name}
          compact
        />
      ) : subTab === "handoff" ? (
        <div className="rounded-xl bg-paper border border-line p-3 space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
            <Share2 size={13} className="text-accent" />
            跨会话 / 跨 Provider 交接上下文
          </div>
          <p className="text-2xs text-ink-muted leading-relaxed">
            自动汇总该会话与所属房间的置顶记忆、架构决策和近期回复，保存为交接档案并直接发送给目标会话（支持 Claude / Codex / Antigravity / 外部终端）。
          </p>
          <select
            value={handoffTarget}
            onChange={(e) => setHandoffTarget(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-surface border border-line text-ink"
          >
            <option value="">选择接收交接的目标会话…</option>
            {peerCandidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.runtime ?? "session"})
              </option>
            ))}
          </select>
          <textarea
            value={handoffPrompt}
            onChange={(e) => setHandoffPrompt(e.target.value)}
            rows={3}
            placeholder="可选：给接手者的下一步具体要求…"
            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-surface border border-line text-ink placeholder:text-ink-faint"
          />
          <button
            type="button"
            disabled={!handoffTarget || handoffMutation.isPending}
            onClick={handleHandoff}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-50"
          >
            {handoffMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
            生成交接并投递
          </button>
          {handoffNotice && <div className="text-2xs text-ink-muted">{handoffNotice}</div>}
        </div>
      ) : (
        <>
          <div className="flex gap-5 text-xs">
            <div>
              <span className="text-ink-faint">上下文</span>
              <div className="text-ink font-medium mt-0.5">{session.context_count}</div>
            </div>
            <div>
              <span className="text-ink-faint">待处理</span>
              <div className="text-warning font-medium mt-0.5">{session.pending_inbox}</div>
            </div>
            <div>
              <span className="text-ink-faint">类型</span>
              <div className="text-ink font-medium mt-0.5">
                {managedInstance ? "受管实例" : session.type === "agent" ? "Agent" : "会话"}
              </div>
            </div>
          </div>

          {isSession && !managedInstance && (
            <div>
              <button
                onClick={handleOpenTerminal}
                disabled={openTerminal.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink text-surface text-xs hover:opacity-90 disabled:opacity-50"
                title="在新终端窗口 resume 这个对话"
              >
                {openTerminal.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <TerminalSquare size={13} />
                )}
                在终端打开
              </button>
              {openNote && <div className="text-2xs text-ink-muted mt-1.5">{openNote}</div>}
            </div>
          )}

          {isSession && <InitiateConversation session={session} onOpenEdge={onOpenEdge} />}

          <div>
            <h3 className="text-xs text-ink-muted font-medium mb-2 flex items-center gap-1">
              <FileText size={12} /> 已发布上下文
            </h3>
            {!contextEntries || contextEntries.entries.length === 0 ? (
              <p className="text-xs text-ink-faint">无</p>
            ) : (
              <div className="space-y-2">
                {contextEntries.entries.map((e) => (
                  <div key={e.id} className="p-3 rounded-xl bg-paper border border-line">
                    <div className="flex items-center gap-1.5">
                      {e.pinned && (
                        <span className="text-2xs px-1.5 py-0.5 rounded bg-warning-soft text-warning">
                          置顶
                        </span>
                      )}
                      {e.kind && e.kind !== "note" && (
                        <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-soft text-accent">
                          {e.kind}
                        </span>
                      )}
                      <div className="text-xs text-ink font-medium truncate">{e.title}</div>
                    </div>
                    <div className="text-2xs text-ink-muted mt-1 line-clamp-3">{e.content}</div>
                    {e.tags && e.tags.length > 0 && (
                      <div className="flex gap-1 mt-1.5 flex-wrap">
                        {e.tags.map((t) => (
                          <span
                            key={t}
                            className="text-2xs px-1.5 py-0.5 rounded-md bg-accent-soft text-accent border border-accent/20"
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
        </>
      )}
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
      <h3 className="text-xs text-ink-muted font-medium mb-2 flex items-center gap-1">
        <ArrowRight size={12} /> 发起对话通道
      </h3>
      {session.status !== "active" && (
        <div className="text-2xs text-warning bg-warning-soft border border-warning/30 rounded-md px-2 py-1 mb-2">
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
