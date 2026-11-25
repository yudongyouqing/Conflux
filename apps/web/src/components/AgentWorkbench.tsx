import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentThread,
  ApprovalMode,
  CliProbeEntry,
  ManagedDeliveryMode,
  ProjectFileMatch,
  RuntimeId,
  ThreadApproval,
  ThreadCheckpoint,
  ThreadEvent,
} from "@conflux/shared";
import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileCode2,
  History,
  RotateCcw,
  Send,
  Shield,
  Square,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useThreadDetail, useThreadEvents } from "../hooks";
import { ApprovalCard, type ResolveApprovalParams } from "./ApprovalCard";
import { MarkdownText } from "./MarkdownText";
import { RuntimeGlyph } from "./brand-icons";

interface AgentWorkbenchProps {
  threadId: string;
  cliProbes: CliProbeEntry[];
  allThreads: AgentThread[];
  onResolveApproval: (params: ResolveApprovalParams) => Promise<unknown> | void;
  onSelectThread: (threadId: string) => void;
  forkModalOpen: boolean;
  onSetForkModalOpen: (open: boolean) => void;
  onCheckpointRollback?: (checkpointId: number) => Promise<void>;
}

interface TimelineItem {
  key: string;
  kind: "user" | "text" | "thinking" | "tool" | "approval" | "status" | "error";
  runId: number | null;
  createdAt: string;
  text?: string;
  payload: Record<string, unknown>;
}

function buildTimeline(events: ThreadEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const ev of events) {
    if (ev.type === "text" || ev.type === "thinking") {
      const chunk =
        typeof ev.payload.text === "string"
          ? ev.payload.text
          : typeof ev.payload.delta === "string"
            ? ev.payload.delta
            : "";
      if (!chunk) continue;
      const last = items[items.length - 1];
      if (last && last.kind === ev.type && last.runId === ev.run_id) {
        last.text = (last.text ?? "") + chunk;
      } else {
        items.push({
          key: `ev-${ev.seq}`,
          kind: ev.type,
          runId: ev.run_id,
          createdAt: ev.created_at,
          text: chunk,
          payload: ev.payload,
        });
      }
      continue;
    }

    items.push({
      key: `ev-${ev.seq}`,
      kind: ev.type,
      runId: ev.run_id,
      createdAt: ev.created_at,
      text:
        typeof ev.payload.text === "string"
          ? ev.payload.text
          : typeof ev.payload.message === "string"
            ? ev.payload.message
            : undefined,
      payload: ev.payload,
    });
  }
  return items;
}

function extractInlineDiff(payload: Record<string, unknown>): {
  path?: string;
  oldText?: string;
  newText?: string;
  unified?: string;
} | null {
  const diffObj = payload.diff;
  if (diffObj && typeof diffObj === "object") {
    const rec = diffObj as Record<string, unknown>;
    const oldText =
      typeof rec.oldText === "string"
        ? rec.oldText
        : typeof rec.old === "string"
          ? rec.old
          : undefined;
    const newText =
      typeof rec.newText === "string"
        ? rec.newText
        : typeof rec.new === "string"
          ? rec.new
          : undefined;
    const path =
      typeof rec.path === "string"
        ? rec.path
        : typeof payload.path === "string"
          ? payload.path
          : undefined;
    if (oldText !== undefined || newText !== undefined) {
      return { path, oldText, newText };
    }
  }
  if (typeof diffObj === "string" && diffObj.trim()) {
    return {
      path: typeof payload.path === "string" ? payload.path : undefined,
      unified: diffObj,
    };
  }
  const input = payload.input;
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    const oldText =
      typeof rec.old_string === "string"
        ? rec.old_string
        : typeof rec.oldText === "string"
          ? rec.oldText
          : undefined;
    const newText =
      typeof rec.new_string === "string"
        ? rec.new_string
        : typeof rec.newText === "string"
          ? rec.newText
          : undefined;
    if (oldText !== undefined || newText !== undefined) {
      return {
        path:
          typeof rec.file_path === "string"
            ? rec.file_path
            : typeof rec.path === "string"
              ? rec.path
              : undefined,
        oldText,
        newText,
      };
    }
  }
  return null;
}

function InlineToolDiff({ diff }: { diff: NonNullable<ReturnType<typeof extractInlineDiff>> }) {
  if (diff.unified) {
    return (
      <div
        data-testid="inline-tool-diff"
        className="mt-1.5 overflow-x-auto rounded-md border border-line bg-paper font-mono text-2xs leading-relaxed"
      >
        {diff.path && (
          <div className="border-b border-line bg-tile px-2.5 py-1 text-ink">{diff.path}</div>
        )}
        {diff.unified.split(/\r?\n/).map((line, i) => {
          const cls =
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-success-soft/80 text-success"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-danger-soft/80 text-danger"
                : "text-ink-muted";
          return (
            <div key={i} className={`whitespace-pre px-2.5 py-0.2 ${cls}`}>
              {line || " "}
            </div>
          );
        })}
      </div>
    );
  }

  const oldLines = diff.oldText ? diff.oldText.split(/\r?\n/) : [];
  const newLines = diff.newText ? diff.newText.split(/\r?\n/) : [];
  return (
    <div
      data-testid="inline-tool-diff"
      className="mt-1.5 overflow-x-auto rounded-md border border-line bg-paper font-mono text-2xs leading-relaxed"
    >
      {diff.path && (
        <div className="border-b border-line bg-tile px-2.5 py-1 text-ink">{diff.path}</div>
      )}
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="whitespace-pre bg-danger-soft/80 px-2.5 py-0.2 text-danger">
          - {line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="whitespace-pre bg-success-soft/80 px-2.5 py-0.2 text-success">
          + {line}
        </div>
      ))}
    </div>
  );
}

function ToolRow({ item }: { item: TimelineItem }) {
  const inlineDiff = extractInlineDiff(item.payload);
  const [expanded, setExpanded] = useState(Boolean(inlineDiff));
  const title =
    typeof item.payload.title === "string"
      ? item.payload.title
      : typeof item.payload.name === "string"
        ? item.payload.name
        : typeof item.payload.toolName === "string"
          ? item.payload.toolName
          : "工具调用";
  const status = typeof item.payload.status === "string" ? item.payload.status : null;
  const output =
    typeof item.payload.output === "string"
      ? item.payload.output
      : typeof item.payload.result === "string"
        ? item.payload.result
        : null;
  const command = typeof item.payload.command === "string" ? item.payload.command : null;

  return (
    <div data-testid="timeline-tool-card" className="border-l-2 border-line pl-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-xs text-ink-muted hover:text-ink transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-ink-faint" />
        <span className="truncate font-mono text-2xs font-medium text-ink">{title}</span>
        {command && (
          <span className="hidden truncate font-mono text-2xs text-ink-faint sm:inline">
            {command}
          </span>
        )}
        {status && (
          <span className="ml-auto shrink-0 font-mono text-2xs text-ink-faint">{status}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1.5 pb-1">
          {command && (
            <pre className="overflow-x-auto rounded-md bg-tile px-2.5 py-1.5 font-mono text-2xs text-ink">
              $ {command}
            </pre>
          )}
          {inlineDiff && <InlineToolDiff diff={inlineDiff} />}
          {output && (
            <pre className="max-h-48 overflow-auto rounded-md bg-tile px-2.5 py-1.5 font-mono text-2xs text-ink-muted whitespace-pre-wrap">
              {output}
            </pre>
          )}
          {!command && !inlineDiff && !output && (
            <pre className="max-h-40 overflow-auto rounded-md bg-tile px-2.5 py-1.5 font-mono text-2xs text-ink-muted">
              {JSON.stringify(item.payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l-2 border-line pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 py-0.5 text-2xs text-ink-faint hover:text-ink transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>思考过程（{text.length} 字）</span>
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap pb-1 text-xs leading-relaxed text-ink-muted">
          {text}
        </div>
      )}
    </div>
  );
}

const PRIMARY_FORK_RUNTIMES: RuntimeId[] = ["antigravity", "claude", "codex"];

export function AgentWorkbench({
  threadId,
  cliProbes,
  onResolveApproval,
  onSelectThread,
  forkModalOpen,
  onSetForkModalOpen,
}: AgentWorkbenchProps) {
  const qc = useQueryClient();
  const detailQuery = useThreadDetail(threadId);
  const eventsQuery = useThreadEvents(threadId);

  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // @ project file search autocomplete
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [atMatches, setAtMatches] = useState<ProjectFileMatch[]>([]);
  const [atActiveIdx, setAtActiveIdx] = useState(0);

  // Fork & Handoff modal state
  const [forkRuntime, setForkRuntime] = useState<RuntimeId>("claude");
  const [forkModel, setForkModel] = useState("");
  const [forkName, setForkName] = useState("");
  const [forkPrompt, setForkPrompt] = useState("");
  const [forkBusy, setForkBusy] = useState(false);

  const scrollEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const thread = detailQuery.data?.thread;
  const runs = detailQuery.data?.runs ?? [];
  const pendingApprovals: ThreadApproval[] = detailQuery.data?.pending_approvals ?? [];
  const checkpoints: ThreadCheckpoint[] = detailQuery.data?.checkpoints ?? [];
  const events = eventsQuery.data?.events ?? [];

  const timeline = useMemo(() => buildTimeline(events), [events]);

  const checkpointByRun = useMemo(() => {
    const map = new Map<number, ThreadCheckpoint>();
    for (const cp of checkpoints) {
      if (cp.run_id !== null) map.set(cp.run_id, cp);
    }
    return map;
  }, [checkpoints]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [timeline.length, pendingApprovals.length]);

  const acpProbe = cliProbes.find((p) => p.runtime === "acp");
  const forkChoices: RuntimeId[] = acpProbe?.available
    ? [...PRIMARY_FORK_RUNTIMES, "acp"]
    : PRIMARY_FORK_RUNTIMES;

  useEffect(() => {
    if (!forkModalOpen || !thread) return;
    const alt =
      cliProbes.find(
        (p) => PRIMARY_FORK_RUNTIMES.includes(p.runtime) && p.available && p.runtime !== thread.runtime,
      )?.runtime ??
      PRIMARY_FORK_RUNTIMES.find((r) => r !== thread.runtime) ??
      "claude";
    setForkRuntime(alt);
    setForkModel("");
    setForkName("");
    setForkPrompt("");
  }, [forkModalOpen, thread, cliProbes]);

  useEffect(() => {
    if (atQuery === null) {
      setAtMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .searchThreadFiles(threadId, atQuery)
        .then((res) => {
          if (!cancelled) {
            setAtMatches(res.files);
            setAtActiveIdx(0);
          }
        })
        .catch(() => {
          if (!cancelled) setAtMatches([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atQuery, threadId]);

  const invalidateThread = () => {
    void qc.invalidateQueries({ queryKey: ["thread-detail", threadId] });
    void qc.invalidateQueries({ queryKey: ["thread-events", threadId] });
    void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
    void qc.invalidateQueries({ queryKey: ["thread-git-status", threadId] });
    void qc.invalidateQueries({ queryKey: ["thread-git-diff", threadId] });
  };

  const handlePromptChange = (val: string) => {
    setPrompt(val);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(val);
    if (match) {
      setAtQuery(match[1]);
    } else {
      setAtQuery(null);
    }
  };

  const insertAtFile = (filePath: string) => {
    setPrompt((prev) => prev.replace(/(^|\s)@([^\s@]*)$/, `$1@${filePath} `));
    setAtQuery(null);
    setAtMatches([]);
    textareaRef.current?.focus();
  };

  const handleSend = async (deliveryMode: ManagedDeliveryMode = "queue") => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setSending(true);
    setActionError(null);
    try {
      if (deliveryMode === "steer") {
        await api.steerThread(threadId, trimmed);
      } else {
        await api.sendPrompt(threadId, { prompt: trimmed, delivery_mode: deliveryMode });
      }
      setPrompt("");
      setAtQuery(null);
      invalidateThread();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleInterrupt = async () => {
    setActionError(null);
    try {
      await api.interruptThread(threadId);
      invalidateThread();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleModelSwitch = async (nextModel: string) => {
    if (!thread || !nextModel) return;
    setActionError(null);
    try {
      const res = await api.switchThreadModel(thread.id, nextModel);
      setActionNotice(
        res.hotSwitched ? `已切换模型为 ${nextModel}` : `模型已更新为 ${nextModel}（下一轮生效）`,
      );
      invalidateThread();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApprovalModeToggle = async (nextMode: ApprovalMode) => {
    if (!thread || thread.approval_mode === nextMode) return;
    setActionError(null);
    try {
      await api.setApprovalMode(thread.id, nextMode);
      invalidateThread();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRollback = async (checkpointId: number) => {
    setActionError(null);
    try {
      await api.rollbackCheckpoint(threadId, checkpointId);
      setActionNotice(`已回滚工作区到快照 #${checkpointId}`);
      invalidateThread();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleForkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!thread) return;
    setForkBusy(true);
    setActionError(null);
    try {
      const res = await api.forkAndHandoff(thread.id, {
        target_runtime: forkRuntime,
        model: forkModel || null,
        name: forkName.trim() || undefined,
        prompt: forkPrompt.trim() || undefined,
      });
      onSetForkModalOpen(false);
      void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
      onSelectThread(res.target_thread.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setForkBusy(false);
    }
  };

  if (detailQuery.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-xs text-ink-faint">
        加载工作台...
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-xs text-danger">
        找不到该 Agent 线程
      </div>
    );
  }

  const probe = cliProbes.find((p) => p.runtime === thread.runtime);
  const models = probe?.models ?? [];
  const isBusy = thread.state === "running" || thread.state === "waiting_approval";
  const forkProbe = cliProbes.find((p) => p.runtime === forkRuntime);

  return (
    <div data-testid="agent-workbench" className="flex min-w-0 flex-1 flex-col bg-surface">
      {/* Transient feedback banner (only when needed) */}
      {(actionError || actionNotice) && (
        <div
          className={`flex items-center justify-between border-b border-line px-4 py-1.5 text-xs ${
            actionError ? "bg-danger-soft text-danger" : "bg-info-soft text-info"
          }`}
        >
          <span>{actionError ?? actionNotice}</span>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setActionNotice(null);
            }}
            className="rounded p-0.5 hover:bg-tile"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Calm flat document timeline */}
      <div data-testid="workbench-timeline" className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-[760px] space-y-5">
          {timeline.length === 0 && pendingApprovals.length === 0 && (
            <div className="py-16 text-center">
              <div className="mx-auto inline-flex h-9 w-9 items-center justify-center rounded-lg bg-tile text-ink-muted">
                <RuntimeGlyph runtime={thread.runtime} size={18} />
              </div>
              <h2 className="mt-3 text-sm font-medium text-ink">{thread.name}</h2>
              <p className="mt-1 font-mono text-2xs text-ink-faint">{thread.workdir}</p>
              <p className="mt-2 text-xs text-ink-muted">
                输入指令开始编写代码；输入 <span className="font-mono text-ink">@</span> 引用项目文件。
              </p>
            </div>
          )}

          {timeline.map((item) => {
            if (item.kind === "user") {
              const cp = item.runId !== null ? checkpointByRun.get(item.runId) : undefined;
              const isSteer = Boolean(item.payload.steer) || item.payload.phase === "steered";
              return (
                <div key={item.key} className="space-y-2">
                  {cp && (
                    <div className="flex items-center gap-2 text-2xs text-ink-faint">
                      <div className="h-px flex-1 bg-line" />
                      <span className="inline-flex items-center gap-1 font-mono">
                        <History className="h-3 w-3" />
                        快照 #{cp.id}
                      </span>
                      <button
                        type="button"
                        data-testid={`checkpoint-rollback-${cp.id}`}
                        onClick={() => void handleRollback(cp.id)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-muted hover:bg-tile-hover hover:text-warning transition-colors"
                      >
                        <RotateCcw className="h-3 w-3" />
                        回滚到此轮前
                      </button>
                      <div className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <div className="rounded-lg bg-tile px-3.5 py-2.5 text-ink">
                    {isSteer && (
                      <div className="mb-1 text-2xs font-medium text-warning">Steer 实时纠偏</div>
                    )}
                    <MarkdownText>{item.text ?? ""}</MarkdownText>
                  </div>
                </div>
              );
            }

            if (item.kind === "thinking") {
              return <ThinkingRow key={item.key} text={item.text ?? ""} />;
            }

            if (item.kind === "tool") {
              return <ToolRow key={item.key} item={item} />;
            }

            if (item.kind === "text") {
              return (
                <div key={item.key} className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-2xs text-ink-faint">
                    <RuntimeGlyph runtime={thread.runtime} size={12} />
                    <span className="font-medium text-ink-muted">{thread.name}</span>
                  </div>
                  <div className="text-ink">
                    <MarkdownText>{item.text ?? ""}</MarkdownText>
                  </div>
                </div>
              );
            }

            if (item.kind === "error") {
              return (
                <div
                  key={item.key}
                  className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="whitespace-pre-wrap">
                    {item.text ?? JSON.stringify(item.payload)}
                  </span>
                </div>
              );
            }

            if (item.kind === "approval" && item.payload.autoApproved) {
              return (
                <div
                  key={item.key}
                  className="inline-flex items-center gap-1.5 rounded-md bg-info-soft/60 px-2 py-0.5 text-2xs text-info"
                >
                  <Zap className="h-3 w-3" />
                  <span>Auto 自动放行</span>
                </div>
              );
            }

            if (item.kind === "status") {
              if (item.payload.phase === "checkpoint" || item.payload.status === "completed") {
                return null;
              }
              const label =
                item.text ??
                (item.payload.phase === "checkpoint_restored"
                  ? `已回滚到快照 #${String(item.payload.checkpointId ?? "")}`
                  : typeof item.payload.status === "string"
                    ? item.payload.status
                    : null);
              if (!label) return null;
              return (
                <div key={item.key} className="font-mono text-2xs text-ink-faint">
                  {label}
                </div>
              );
            }

            return null;
          })}

          {isBusy && (
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <span>执行中</span>
              <span className="smooth-caret" />
            </div>
          )}

          {/* Inline pending approvals */}
          {pendingApprovals.map((ap) => (
            <ApprovalCard key={ap.id} approval={ap} onResolve={onResolveApproval} />
          ))}

          {timeline.length === 0 && runs.length > 0 && (
            <div className="text-center text-2xs text-ink-faint">
              共 {runs.length} 次历史执行记录
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>
      </div>

      {/* Minimalist T3Code / Linear bottom composer with inline Model & Ask/Auto controls */}
      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mx-auto max-w-[760px]">
          {atQuery !== null && atMatches.length > 0 && (
            <div
              data-testid="at-file-popover"
              className="mb-1.5 max-h-48 overflow-y-auto rounded-lg border border-line-strong bg-surface p-1 shadow-raised"
            >
              {atMatches.map((file, idx) => (
                <button
                  key={file.path}
                  type="button"
                  data-testid={`at-file-option-${idx}`}
                  onClick={() => insertAtFile(file.path)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-xs transition-colors ${
                    idx === atActiveIdx
                      ? "bg-tile-active text-ink"
                      : "text-ink-muted hover:bg-tile-hover"
                  }`}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="truncate">{file.path}</span>
                </button>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-line-strong bg-paper/50 transition-colors focus-within:border-accent focus-within:bg-surface">
            <textarea
              ref={textareaRef}
              data-testid="workbench-composer-input"
              rows={2}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={(e) => {
                if (atQuery !== null && atMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setAtActiveIdx((i) => (i + 1) % atMatches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setAtActiveIdx((i) => (i - 1 + atMatches.length) % atMatches.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    insertAtFile(atMatches[atActiveIdx].path);
                    return;
                  }
                  if (e.key === "Escape") {
                    setAtQuery(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend(isBusy && thread.supports_steer ? "steer" : "queue");
                }
              }}
              placeholder={
                thread.kind === "external"
                  ? "发送消息到外部终端 MCP 收件箱..."
                  : isBusy
                    ? "输入 Steer 纠偏指令或排队消息..."
                    : "输入编码指令... (@ 检索文件，Enter 发送)"
              }
              className="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2 pt-1">
              {/* Inline composer controls: model + ask/auto */}
              <div className="flex flex-wrap items-center gap-1.5">
                {thread.kind === "managed" && models.length > 0 && (
                  <label className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-ink-muted hover:bg-tile-hover transition-colors">
                    <Cpu className="h-3 w-3 shrink-0 opacity-70" />
                    <select
                      data-testid="workbench-model-select"
                      aria-label="切换同系模型"
                      value={thread.model ?? ""}
                      onChange={(e) => void handleModelSwitch(e.target.value)}
                      className="cursor-pointer bg-transparent font-mono text-2xs text-ink-muted focus:text-ink focus:outline-none"
                    >
                      <option value="">默认模型</option>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {thread.kind === "managed" && (
                  <div
                    data-testid="approval-mode-toggle"
                    className="inline-flex rounded-md bg-tile p-0.5"
                  >
                    <button
                      type="button"
                      data-testid="approval-mode-ask"
                      onClick={() => void handleApprovalModeToggle("ask")}
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors ${
                        thread.approval_mode === "ask"
                          ? "bg-surface font-medium text-ink shadow-card"
                          : "text-ink-faint hover:text-ink"
                      }`}
                    >
                      <Shield className="h-2.5 w-2.5" />
                      Ask
                    </button>
                    <button
                      type="button"
                      data-testid="approval-mode-auto"
                      onClick={() => void handleApprovalModeToggle("auto")}
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors ${
                        thread.approval_mode === "auto"
                          ? "bg-warning-soft font-medium text-warning"
                          : "text-ink-faint hover:text-ink"
                      }`}
                    >
                      <Zap className="h-2.5 w-2.5" />
                      Auto
                    </button>
                  </div>
                )}

                {thread.kind === "external" && (
                  <span className="text-2xs text-ink-faint">外部终端（审批在本地终端完成）</span>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1.5">
                {isBusy && thread.kind === "managed" && (
                  <>
                    <button
                      type="button"
                      data-testid="composer-interrupt-btn"
                      onClick={() => void handleInterrupt()}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-danger hover:bg-danger-soft transition-colors"
                    >
                      <Square className="h-3 w-3" />
                      中断
                    </button>
                    {thread.supports_steer && (
                      <button
                        type="button"
                        disabled={sending || !prompt.trim()}
                        data-testid="composer-steer-btn"
                        onClick={() => void handleSend("steer")}
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-warning-soft px-2.5 text-xs font-medium text-warning disabled:opacity-50"
                      >
                        Steer
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  disabled={sending || !prompt.trim()}
                  data-testid="composer-send-btn"
                  onClick={() => void handleSend("queue")}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-40 transition-colors"
                >
                  <Send className="h-3 w-3" />
                  {isBusy ? "排队" : "发送"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Fork & Handoff Modal */}
      {forkModalOpen && (
        <div
          data-testid="fork-handoff-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-line-strong bg-surface p-4 shadow-overlay">
            <div className="flex items-center justify-between">
              <h3 className="text-[13.5px] font-semibold text-ink">原地接力 (Fork & Handoff)</h3>
              <button
                type="button"
                onClick={() => onSetForkModalOpen(false)}
                className="rounded-md p-1 text-ink-muted hover:bg-tile-hover"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              停止 <span className="font-medium text-ink">{thread.name}</span>，打包摘要并在相同目录启动目标引擎。
            </p>
            <form onSubmit={(e) => void handleForkSubmit(e)} className="mt-3.5 space-y-3">
              <div className={`grid gap-1.5 ${forkChoices.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
                {forkChoices.map((rid) => (
                  <button
                    key={rid}
                    type="button"
                    onClick={() => {
                      setForkRuntime(rid);
                      setForkModel("");
                    }}
                    className={`flex flex-col items-center gap-1 rounded-lg border py-2 text-2xs font-medium transition-colors ${
                      forkRuntime === rid
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-line bg-paper/60 text-ink-muted hover:bg-tile-hover"
                    }`}
                  >
                    <RuntimeGlyph runtime={rid} size={14} />
                    {rid}
                  </button>
                ))}
              </div>

              {(forkProbe?.models?.length ?? 0) > 0 && (
                <select
                  value={forkModel}
                  onChange={(e) => setForkModel(e.target.value)}
                  className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 font-mono text-xs text-ink"
                >
                  <option value="">默认模型</option>
                  {forkProbe?.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}

              <input
                type="text"
                value={forkName}
                onChange={(e) => setForkName(e.target.value)}
                placeholder={`新线程名称（默认：${thread.name} → ${forkRuntime}）`}
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink"
              />

              <textarea
                rows={2}
                value={forkPrompt}
                onChange={(e) => setForkPrompt(e.target.value)}
                placeholder="给接棒 Agent 的下一步指令（可选）..."
                className="w-full rounded-md border border-line bg-paper/60 px-2.5 py-1.5 text-xs text-ink"
              />

              <div className="flex justify-end gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => onSetForkModalOpen(false)}
                  className="rounded-md px-3 py-1.5 text-xs text-ink-muted hover:bg-tile-hover"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={forkBusy}
                  data-testid="fork-handoff-submit-btn"
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  {forkBusy ? "接力中..." : "确认接力"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
