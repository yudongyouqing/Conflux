import { useState } from "react";
import { Loader2, Send, Square, Zap } from "lucide-react";
import { api } from "../api";
import {
  useInterruptManagedTurn,
  useManagedEvents,
  useManagedStatus,
  useResolveManagedApproval,
  useSteerManagedTurn,
} from "../hooks";

/**
 * Runtime-agnostic execution panel for a managed instance (Claude Code, Codex,
 * Antigravity `agy acp`, or generic ACP): live binding, current run state,
 * incremental event stream, native optionId / question approvals, active-turn
 * steering, and turn interruption. Supports standalone and compact embedded modes.
 */

const RUN_STYLE: Record<string, string> = {
  queued: "text-neutral bg-neutral-soft",
  submitting: "text-info bg-info-soft",
  running: "text-info bg-info-soft",
  waiting_approval: "text-warning bg-warning-soft",
  completed: "text-success bg-success-soft",
  failed: "text-danger bg-danger-soft",
  interrupted: "text-neutral bg-neutral-soft",
  unknown: "text-warning bg-warning-soft",
};

const RUN_LABEL: Record<string, string> = {
  queued: "排队中",
  submitting: "提交中",
  running: "执行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  unknown: "执行状态待核对",
};

const RUNTIME_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity (agy)",
  acp: "ACP Agent",
};

const APPROVAL_TITLE: Record<string, string> = {
  fileChange: "文件修改审批",
  commandExecution: "命令执行审批",
  userInput: "Agent 提问 / 选择",
  toolCall: "工具调用审批",
};

export interface ManagedCodexPanelProps {
  instanceId: string;
  instanceName: string;
  /** Panel pauses polling while another view is showing. */
  active?: boolean;
  /** Compact mode embeds directly inside DetailPanel without outer padding/back button. */
  compact?: boolean;
  onBack?: () => void;
}

export function ManagedCodexPanel({
  instanceId,
  instanceName,
  active = true,
  compact = false,
  onBack,
}: ManagedCodexPanelProps) {
  const statusQuery = useManagedStatus(instanceId, active);
  const eventsQuery = useManagedEvents(instanceId, active);
  const interrupt = useInterruptManagedTurn();
  const steer = useSteerManagedTurn();
  const approve = useResolveManagedApproval();

  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState<Record<number, string>>({});

  const status = statusQuery.data;
  const binding = status?.binding ?? null;
  const current = status?.current ?? null;
  const approvals = current?.pendingApprovals ?? [];
  const runs = status?.runs ?? [];
  const events = eventsQuery.data ?? [];
  const runtimeTag = current?.runtime ? (RUNTIME_LABEL[current.runtime] ?? current.runtime) : null;
  const canSteerNow = Boolean(current?.live && current?.activeRun && current?.supportsSteer);

  const sendQuestion = async (mode: "queue" | "steer" = "queue") => {
    const text = question.trim();
    if (!text || !binding || sending) return;
    setSending(true);
    setSendError(null);
    try {
      if (mode === "steer" && canSteerNow) {
        const res = await steer.mutateAsync({
          instanceId,
          text,
          expectedTurnId: current?.activeRun?.turnId ?? null,
        });
        if (!res.accepted) {
          throw new Error(res.reason ?? "当前无法插话，已改用排队发送");
        }
      } else {
        await api.webAsk({ to_session: binding.session_id, question: text });
      }
      setQuestion("");
      statusQuery.refetch();
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={compact ? "space-y-3" : "h-full overflow-y-auto p-3 sm:p-6"}>
      <div className={compact ? "space-y-3" : "max-w-2xl mx-auto space-y-4"}>
        {!compact && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-ink font-semibold text-base">{instanceName} · 受管执行</h2>
                {runtimeTag && (
                  <span className="rounded-md px-2 py-0.5 text-2xs bg-accent-soft text-accent">
                    {runtimeTag}
                  </span>
                )}
              </div>
              <p className="text-2xs text-ink-muted font-mono break-all mt-0.5">
                {binding ? `thread ${binding.thread_id}` : "尚未绑定 thread"}
              </p>
            </div>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="px-3 py-1.5 rounded-lg border border-line text-xs text-ink-muted hover:bg-tile-hover"
              >
                返回助手列表
              </button>
            )}
          </div>
        )}

        {statusQuery.error && (
          <p role="alert" className="text-xs text-danger px-3 py-2 rounded-lg bg-danger-soft">
            受管实例不可用：{(statusQuery.error as Error).message}
          </p>
        )}

        {/* current execution + queue + interrupt */}
        <section className="rounded-xl bg-surface border border-line p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`shrink-0 rounded-md px-2 py-0.5 text-2xs ${
                  status && !current?.live
                    ? RUN_STYLE.interrupted
                    : current?.activeRun
                      ? (RUN_STYLE[current.activeRun.state] ?? RUN_STYLE.running)
                      : RUN_STYLE.queued
                }`}
              >
                {status && !current?.live
                  ? "已停止"
                  : current?.activeRun
                    ? (RUN_LABEL[current.activeRun.state] ?? "执行中")
                    : "空闲"}
              </span>
              {compact && runtimeTag && (
                <span className="rounded-md px-1.5 py-0.5 text-2xs bg-tile text-ink-muted">
                  {runtimeTag}
                </span>
              )}
              {current && current.queuedRunIds.length > 0 && (
                <span className="text-2xs text-ink-muted">队列 {current.queuedRunIds.length} 项</span>
              )}
            </div>
            <button
              type="button"
              disabled={!current?.activeRun || interrupt.isPending}
              onClick={() =>
                current?.activeRun &&
                interrupt.mutate({
                  instanceId,
                  expectedTurnId: current.activeRun?.turnId ?? null,
                })
              }
              title="中断当前任务（不影响实例本身；停止实例请在助手列表操作）"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-danger/30 text-danger bg-danger-soft disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {interrupt.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Square size={12} />
              )}
              中断任务
            </button>
          </div>
          {status && !current?.live && (
            <p role="status" className="text-2xs text-ink-muted">
              实例当前不在线（已停止、崩溃或由其他进程持有）：以下为持久化记录，中断与审批不可用；恢复实例后队列会继续执行。
            </p>
          )}
          {interrupt.error && (
            <p role="alert" className="text-2xs text-danger">
              中断失败：{(interrupt.error as Error).message}
            </p>
          )}
          {interrupt.data && !interrupt.data.accepted && (
            <p role="status" className="text-2xs text-ink-muted">
              {interrupt.data.reason ?? "当前无可中断任务"}
            </p>
          )}
        </section>

        {/* approvals & interactive questions — human-only decisions */}
        {approvals.length > 0 && (
          <section
            className="rounded-xl bg-warning-soft/40 border border-warning/30 p-3 space-y-3"
            aria-label="待审批操作"
          >
            {approvals.map((a) => {
              const nativeOptions = Array.isArray(a.payload.options)
                ? (a.payload.options as Array<{ optionId: string; name?: string; kind?: string }>)
                : [];
              return (
                <div key={a.id} className="space-y-2">
                  <div className="text-xs text-ink font-medium">
                    {APPROVAL_TITLE[a.kind] ?? "操作审批"}
                  </div>
                  <dl className="text-2xs text-ink-muted grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                    {typeof a.payload.toolName === "string" && (
                      <>
                        <dt className="text-ink-faint">工具</dt>
                        <dd className="font-mono break-all">{a.payload.toolName}</dd>
                      </>
                    )}
                    {typeof a.payload.command === "string" && (
                      <>
                        <dt className="text-ink-faint">命令</dt>
                        <dd className="font-mono break-all">{a.payload.command}</dd>
                      </>
                    )}
                    {typeof a.payload.filePath === "string" && (
                      <>
                        <dt className="text-ink-faint">文件</dt>
                        <dd className="font-mono break-all">{a.payload.filePath}</dd>
                      </>
                    )}
                    {typeof a.payload.cwd === "string" && (
                      <>
                        <dt className="text-ink-faint">目录</dt>
                        <dd className="font-mono break-all">{a.payload.cwd}</dd>
                      </>
                    )}
                    {typeof a.payload.grantRoot === "string" && a.payload.grantRoot && (
                      <>
                        <dt className="text-ink-faint">写入范围</dt>
                        <dd className="font-mono break-all">{a.payload.grantRoot}</dd>
                      </>
                    )}
                    {typeof a.payload.question === "string" && (
                      <>
                        <dt className="text-ink-faint">问题</dt>
                        <dd className="break-all">{a.payload.question}</dd>
                      </>
                    )}
                    {typeof a.payload.reason === "string" && a.payload.reason && (
                      <>
                        <dt className="text-ink-faint">原因</dt>
                        <dd className="break-all">{a.payload.reason}</dd>
                      </>
                    )}
                  </dl>

                  {a.kind === "userInput" && nativeOptions.length === 0 && (
                    <div className="flex gap-1.5">
                      <input
                        value={answerText[a.id] ?? ""}
                        onChange={(e) =>
                          setAnswerText((prev) => ({ ...prev, [a.id]: e.target.value }))
                        }
                        placeholder="输入你的回复…"
                        className="flex-1 min-w-0 px-2 py-1 text-2xs rounded-lg bg-surface border border-line text-ink"
                      />
                      <button
                        type="button"
                        disabled={approve.isPending || !(answerText[a.id] ?? "").trim()}
                        onClick={() =>
                          approve.mutate({
                            instanceId,
                            approvalId: a.id,
                            decision: "accept",
                            answers: { reply: (answerText[a.id] ?? "").trim() },
                          })
                        }
                        className="px-2.5 py-1 text-2xs rounded-lg bg-accent text-on-accent disabled:opacity-50"
                      >
                        提交回复
                      </button>
                    </div>
                  )}

                  {nativeOptions.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {nativeOptions.map((opt) => {
                        const isReject = opt.kind?.startsWith("reject");
                        return (
                          <button
                            key={opt.optionId}
                            type="button"
                            disabled={approve.isPending}
                            onClick={() =>
                              approve.mutate({
                                instanceId,
                                approvalId: a.id,
                                decision: isReject ? "decline" : "accept",
                                option_id: opt.optionId,
                              })
                            }
                            className={`px-2.5 py-1.5 text-xs rounded-lg disabled:opacity-50 ${
                              isReject
                                ? "bg-danger text-on-accent"
                                : "bg-success text-on-accent"
                            }`}
                          >
                            {opt.name ?? opt.optionId}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        disabled={approve.isPending}
                        onClick={() =>
                          approve.mutate({ instanceId, approvalId: a.id, decision: "cancel" })
                        }
                        className="px-2.5 py-1.5 text-xs rounded-lg border border-line text-ink-muted hover:bg-tile-hover disabled:opacity-50"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {(["accept", "decline", "cancel"] as const).map((decision) => (
                        <button
                          key={decision}
                          type="button"
                          disabled={approve.isPending}
                          onClick={() =>
                            approve.mutate({ instanceId, approvalId: a.id, decision })
                          }
                          className={`px-2.5 py-1.5 text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                            decision === "accept"
                              ? "bg-success text-on-accent"
                              : decision === "decline"
                                ? "bg-danger text-on-accent"
                                : "border border-line text-ink-muted hover:bg-tile-hover"
                          }`}
                        >
                          {decision === "accept"
                            ? "本次允许"
                            : decision === "decline"
                              ? "拒绝"
                              : "取消任务"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {approve.error && (
              <p role="alert" className="text-2xs text-danger">
                审批失败：{(approve.error as Error).message}
              </p>
            )}
          </section>
        )}

        {/* task input: queue or active-turn steer */}
        <section className="rounded-xl bg-surface border border-line p-3">
          <label htmlFor={`managed-ask-${instanceId}`} className="text-2xs text-ink-faint">
            {canSteerNow
              ? "发送任务（当前执行中：可排队等待或实时插话 Steer）"
              : "发送任务（经现有问答通道，收件人为该受管会话）"}
          </label>
          <div className="flex gap-1.5 mt-1.5">
            <input
              id={`managed-ask-${instanceId}`}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendQuestion("queue");
              }}
              disabled={!binding || sending}
              placeholder={binding ? "描述任务或补充指令…" : "等待受管会话绑定…"}
              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg bg-paper border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            {canSteerNow && (
              <button
                type="button"
                onClick={() => void sendQuestion("steer")}
                disabled={!binding || sending || !question.trim()}
                title="不中断当前任务，实时向正在运行的 turn 插话"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-accent/40 bg-accent-soft text-accent hover:bg-accent hover:text-on-accent disabled:opacity-50"
              >
                <Zap size={12} />
                插话
              </button>
            )}
            <button
              type="button"
              onClick={() => void sendQuestion("queue")}
              disabled={!binding || sending || !question.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-accent text-on-accent hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              发送
            </button>
          </div>
          {sendError && (
            <p role="alert" className="text-2xs text-danger mt-1.5">
              发送失败：{sendError}
            </p>
          )}
        </section>

        {/* event stream */}
        <section className="rounded-xl bg-surface border border-line overflow-hidden">
          <div className="px-3 py-2 border-b border-line text-2xs text-ink-faint">
            执行进展（文本 / 工具 / 状态 · 按序号增量）
          </div>
          <div className="p-3 space-y-1.5 max-h-72 overflow-y-auto">
            {events.length === 0 && (
              <p className="text-2xs text-ink-faint">暂无事件。发送任务后进展会显示在这里。</p>
            )}
            {events.map((e) => (
              <EventLine key={e.sequence} event={e} />
            ))}
            {runs.some((r) => r.state === "unknown") && (
              <p role="status" className="text-2xs text-warning">
                存在执行状态待核对的记录：上次中断时无法确认任务是否已发出，请核对线程历史后再决定重发。
              </p>
            )}
          </div>
        </section>

        {/* recent runs */}
        {runs.length > 0 && (
          <section className="rounded-xl bg-surface border border-line overflow-hidden">
            <div className="px-3 py-2 border-b border-line text-2xs text-ink-faint">最近任务</div>
            <div className="divide-y divide-line">
              {runs.slice(0, compact ? 5 : 20).map((r) => (
                <div key={r.id} className="px-3 py-2 flex flex-wrap items-center gap-2">
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-2xs ${
                      RUN_STYLE[r.state] ?? RUN_STYLE.queued
                    }`}
                  >
                    {RUN_LABEL[r.state] ?? r.state}
                  </span>
                  <span className="text-2xs text-ink-muted font-mono">#{r.message_id}</span>
                  <span className="text-2xs text-ink-muted min-w-0 truncate flex-1">
                    {r.final_text ?? r.error_code ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export const ManagedSessionPanel = ManagedCodexPanel;

function EventLine({ event }: { event: { type: string; payload: Record<string, unknown> } }) {
  const p = event.payload;
  const phase = typeof p.phase === "string" ? p.phase : "";
  const text =
    event.type === "text" && typeof p.text === "string"
      ? p.text
      : event.type === "text" && typeof p.delta === "string"
        ? p.delta
        : event.type === "tool" && typeof p.command === "string"
          ? `$ ${p.command}${typeof p.exitCode === "number" ? ` → ${p.exitCode}` : ""}`
          : event.type === "tool" && typeof p.title === "string"
            ? `[工具] ${p.title}`
            : event.type === "status" && phase === "steered" && typeof p.text === "string"
              ? `[Steer 插话] ${p.text}`
              : event.type === "error" && typeof p.error === "string"
                ? p.error
                : null;
  if (text === null) {
    return (
      <div className="text-2xs text-ink-faint font-mono">
        {event.type} · {phase}
      </div>
    );
  }
  return (
    <div
      className={`text-2xs whitespace-pre-wrap break-words font-mono ${
        event.type === "error"
          ? "text-danger"
          : event.type === "tool"
            ? "text-ink-muted"
            : "text-ink"
      }`}
    >
      {text}
    </div>
  );
}
