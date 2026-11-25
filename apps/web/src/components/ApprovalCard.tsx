import { useState } from "react";
import type { ApprovalDecision, ThreadApproval } from "@conflux/shared";
import { AlertTriangle, Check, CheckCircle2, ExternalLink, MessageSquare, ShieldAlert, X } from "lucide-react";
import { RuntimeGlyph } from "./brand-icons";

interface NativeOption {
  optionId: string;
  name: string;
  kind?: string;
}

interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
}

export interface ResolveApprovalParams {
  threadId: string;
  approvalId: number;
  decision: ApprovalDecision;
  option_id?: string;
  answers?: Record<string, string | string[]>;
}

interface ApprovalCardProps {
  approval: ThreadApproval;
  onResolve: (params: ResolveApprovalParams) => Promise<unknown> | void;
  onJumpToThread?: (threadId: string) => void;
  compact?: boolean;
}

function parseOptions(payload: Record<string, unknown>): NativeOption[] {
  const raw = payload.options;
  if (!Array.isArray(raw)) return [];
  const out: NativeOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const optionId =
      typeof rec.optionId === "string"
        ? rec.optionId
        : typeof rec.id === "string"
          ? rec.id
          : "";
    const name =
      typeof rec.name === "string"
        ? rec.name
        : typeof rec.label === "string"
          ? rec.label
          : optionId;
    if (optionId) {
      out.push({
        optionId,
        name,
        kind: typeof rec.kind === "string" ? rec.kind : undefined,
      });
    }
  }
  return out;
}

function parseQuestions(payload: Record<string, unknown>): UserInputQuestion[] {
  const raw = payload.questions;
  if (!Array.isArray(raw)) return [];
  const out: UserInputQuestion[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : `q_${i}`;
    const question =
      typeof rec.question === "string"
        ? rec.question
        : typeof rec.prompt === "string"
          ? rec.prompt
          : "";
    if (!question) continue;
    const opts = Array.isArray(rec.options)
      ? rec.options
          .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === "object"))
          .map((o) => ({
            label: typeof o.label === "string" ? o.label : String(o.value ?? ""),
            description: typeof o.description === "string" ? o.description : undefined,
          }))
          .filter((o) => o.label.length > 0)
      : undefined;
    out.push({
      id,
      header: typeof rec.header === "string" ? rec.header : undefined,
      question,
      options: opts && opts.length > 0 ? opts : undefined,
    });
  }
  return out;
}

function summarizePayload(approval: ThreadApproval): { title: string; detail: string | null } {
  const p = approval.payload;
  const toolName =
    typeof p.toolName === "string"
      ? p.toolName
      : typeof p.title === "string"
        ? p.title
        : typeof p.kind === "string"
          ? p.kind
          : approval.kind;

  const command =
    typeof p.command === "string"
      ? p.command
      : Array.isArray(p.command)
        ? p.command.join(" ")
        : typeof p.cmd === "string"
          ? p.cmd
          : null;

  const reason =
    typeof p.reason === "string"
      ? p.reason
      : typeof p.description === "string"
        ? p.description
        : null;
  const path =
    typeof p.path === "string" ? p.path : typeof p.filePath === "string" ? p.filePath : null;

  const detail = command ?? path ?? reason ?? null;
  return { title: toolName, detail };
}

export function ApprovalCard({
  approval,
  onResolve,
  onJumpToThread,
  compact = false,
}: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeInput, setFreeInput] = useState("");

  const options = parseOptions(approval.payload);
  const questions = parseQuestions(approval.payload);
  const { title, detail } = summarizePayload(approval);

  if (approval.state === "auto_approved") {
    return (
      <div
        data-testid={`approval-auto-${approval.id}`}
        className="inline-flex items-center gap-1.5 rounded-md bg-info-soft/70 px-2.5 py-1 text-2xs text-info"
      >
        <CheckCircle2 className="h-3 w-3 shrink-0" />
        <span className="font-medium">自动批准</span>
        <span className="truncate font-mono text-ink-muted">{detail ?? title}</span>
      </div>
    );
  }

  if (approval.state !== "pending") {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md bg-tile px-2.5 py-1 text-2xs text-ink-muted">
        <Check className="h-3 w-3 shrink-0" />
        <span>
          审批 #{approval.id} 已处理（{approval.decision ?? approval.state}）
        </span>
      </div>
    );
  }

  const handleAction = async (
    decision: ApprovalDecision,
    extra?: { option_id?: string; answers?: Record<string, string | string[]> },
  ) => {
    setSubmitting(true);
    setError(null);
    try {
      await onResolve({
        threadId: approval.thread_id,
        approvalId: approval.id,
        decision,
        ...extra,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitUserInput = async () => {
    const payloadAnswers: Record<string, string> = {};
    if (questions.length > 0) {
      for (const q of questions) {
        payloadAnswers[q.id] = answers[q.id] ?? "";
      }
    } else {
      payloadAnswers.response = freeInput;
    }
    await handleAction("accept", { answers: payloadAnswers });
  };

  return (
    <div
      data-testid={`approval-card-${approval.id}`}
      className={`rounded-lg border border-warning/35 bg-warning-soft/40 ${compact ? "p-2.5" : "p-3"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {approval.kind === "userInput" ? (
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-warning" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink">
              {approval.kind === "userInput" ? "需要补充信息" : "等待审批"}
            </span>
            {approval.thread_name && (
              <span className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-2xs text-ink-muted">
                {approval.runtime && <RuntimeGlyph runtime={approval.runtime} size={11} />}
                {approval.thread_name}
              </span>
            )}
            <span className="font-mono text-2xs text-warning">{title}</span>
          </div>
        </div>
        {onJumpToThread && (
          <button
            type="button"
            onClick={() => onJumpToThread(approval.thread_id)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent hover:bg-accent-soft transition-colors"
          >
            前往工作台
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>

      {detail && (
        <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-surface/90 px-2.5 py-1.5 font-mono text-2xs text-ink whitespace-pre-wrap break-all">
          {detail}
        </pre>
      )}

      {approval.kind === "userInput" ? (
        <div className="mt-2.5 space-y-2">
          {questions.length > 0 ? (
            questions.map((q) => (
              <div key={q.id} className="space-y-1">
                <label className="block text-xs font-medium text-ink">
                  {q.header ? `${q.header}: ` : ""}
                  {q.question}
                </label>
                {q.options && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt) => {
                      const active = answers[q.id] === opt.label;
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt.label }))}
                          className={`rounded-md border px-2 py-0.5 text-2xs transition-colors ${
                            active
                              ? "border-accent bg-accent-soft font-medium text-accent"
                              : "border-line bg-surface text-ink-muted hover:bg-tile-hover"
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  type="text"
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="输入回答..."
                  className="w-full rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
            ))
          ) : (
            <input
              type="text"
              value={freeInput}
              onChange={(e) => setFreeInput(e.target.value)}
              placeholder="输入回复给 Agent..."
              className="w-full rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink focus:border-accent focus:outline-none"
            />
          )}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleSubmitUserInput()}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              提交回答
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleAction("cancel")}
              className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-tile-hover"
            >
              取消
            </button>
          </div>
        </div>
      ) : options.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {options.map((opt) => {
            const isReject =
              opt.kind?.toLowerCase().includes("reject") ||
              opt.optionId.toLowerCase().includes("reject");
            return (
              <button
                key={opt.optionId}
                type="button"
                disabled={submitting}
                data-testid={`approval-option-${opt.optionId}`}
                onClick={() =>
                  void handleAction(isReject ? "decline" : "accept", { option_id: opt.optionId })
                }
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  isReject
                    ? "bg-surface text-danger hover:bg-danger-soft"
                    : "bg-accent text-on-accent hover:bg-accent-deep"
                }`}
              >
                {isReject ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                {opt.name}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={submitting}
            data-testid={`approval-accept-${approval.id}`}
            onClick={() => void handleAction("accept")}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-deep disabled:opacity-50"
          >
            <Check className="h-3 w-3" />
            允许执行
          </button>
          <button
            type="button"
            disabled={submitting}
            data-testid={`approval-decline-${approval.id}`}
            onClick={() => void handleAction("decline")}
            className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            拒绝
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-2xs text-danger">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
