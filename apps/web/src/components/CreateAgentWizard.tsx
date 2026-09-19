import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Terminal,
  X,
  Loader2,
  FolderOpen,
  Search,
  Compass,
  ChevronDown,
} from "lucide-react";
import { useCreateAgent, useCreateRuntimeAgent, useRuntimes, useSessions } from "../hooks";
import { ClaudeIcon, OpenAIIcon } from "./brand-icons";
import type { ComponentType } from "react";

/** Brand glyph per known runtime id; unknown runtimes fall back to Terminal. */
const RUNTIME_GLYPH: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  claude: ClaudeIcon,
  codex: OpenAIIcon,
};
const runtimeGlyph = (id: string): ComponentType<{ size?: number; className?: string }> =>
  RUNTIME_GLYPH[id] ?? Terminal;

/**
 * Unified creation wizard for both agent kinds. Step 1 asks WHICH KIND —
 * the two are different machines (an API chat persona vs a real CLI in a
 * terminal), and the old two-tab buttons never said so. Step 2 shows the
 * matching form; the created item lands in its own tab's list.
 */

type WizardKind = "agent" | "runtime" | null;

export function CreateAgentWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<WizardKind>(null);

  // re-open always starts from the type chooser, forms reset
  useEffect(() => {
    if (open) setKind(null);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border border-line rounded-2xl shadow-overlay w-full max-w-lg max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-line sticky top-0 bg-white rounded-t-2xl">
          <h3 className="text-sm font-semibold text-ink">
            {kind === null ? "创建智能体" : kind === "agent" ? "新建模型智能体" : "新建 CLI 运行时"}
          </h3>
          <button onClick={onClose} className="text-ink-faint hover:text-ink" title="关闭">
            <X size={15} />
          </button>
        </div>

        {kind === null ? (
          <TypeChooser onPick={setKind} />
        ) : kind === "agent" ? (
          <>
            <StepBack onBack={() => setKind(null)} label="模型智能体" />
            <AgentCreateForm onClose={onClose} />
          </>
        ) : (
          <>
            <StepBack onBack={() => setKind(null)} label="CLI 运行时" />
            <RuntimeCreateForm onClose={onClose} />
          </>
        )}
      </div>
    </div>
  );
}

function StepBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="px-5 pt-3">
      <button
        onClick={onBack}
        className="text-[11px] text-ink-faint hover:text-ink inline-flex items-center gap-1"
      >
        ← 重新选择类型（当前：{label}）
      </button>
    </div>
  );
}

function TypeChooser({ onPick }: { onPick: (k: "agent" | "runtime") => void }) {
  return (
    <div className="px-5 py-4 space-y-3">
      <button
        onClick={() => onPick("agent")}
        className="w-full text-left rounded-xl border border-line hover:border-accent/50 hover:bg-accent-soft/40 transition-colors p-4"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <Bot size={15} className="text-white" />
          </div>
          <span className="text-sm font-semibold text-ink">模型智能体</span>
        </div>
        <p className="text-xs text-ink-muted mt-2 leading-5">
          在应用里直接对话的 API 人格：给它系统提示词和模型，适合问答、总结类任务。
          不读写项目文件。
        </p>
      </button>

      <button
        onClick={() => onPick("runtime")}
        className="w-full text-left rounded-xl border border-line hover:border-orange-400/60 hover:bg-orange-50/40 transition-colors p-4"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center flex-shrink-0">
            <Terminal size={15} className="text-white" />
          </div>
          <span className="text-sm font-semibold text-ink">CLI 运行时</span>
        </div>
        <p className="text-xs text-ink-muted mt-2 leading-5">
          真正的 Claude Code / Codex：选一个项目工作目录，在终端窗口启动，
          读写真实代码、跑构建。出现在图拓扑里，可被其他会话提问。
        </p>
      </button>
    </div>
  );
}

// ---- 模型智能体表单（原 Agents 页内联表单） --------------------------------

const PROVIDERS = ["anthropic", "openai", "google", "mistral", "local"];

function AgentCreateForm({ onClose }: { onClose: () => void }) {
  const createMut = useCreateAgent();
  const [form, setForm] = useState({
    name: "",
    description: "",
    provider: "anthropic",
    model: "",
    system_prompt: "",
  });

  const handleCreate = () => {
    if (!form.name || !form.model || !form.system_prompt) return;
    createMut.mutate(
      {
        name: form.name,
        system_prompt: form.system_prompt,
        model_config: {
          provider: form.provider,
          model: form.model,
        },
        description: form.description || undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input
          placeholder="名称 *"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className={inputCls}
        />
        <input
          placeholder="描述"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className={inputCls}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <select
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
          className={inputCls}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          placeholder="模型 * (如 claude-sonnet-4-5)"
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          className={inputCls}
        />
      </div>
      <textarea
        placeholder="System Prompt *"
        value={form.system_prompt}
        onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
        rows={4}
        className="w-full bg-white text-ink text-xs rounded-lg px-3 py-2 border border-line outline-none focus:border-accent resize-y font-mono"
      />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-paper"
        >
          取消
        </button>
        <button
          onClick={handleCreate}
          disabled={!form.name || !form.model || !form.system_prompt || createMut.isPending}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent hover:bg-accent-deep disabled:bg-paper disabled:text-ink-faint text-white transition-colors"
        >
          {createMut.isPending ? "创建中..." : "创建"}
        </button>
      </div>
      {createMut.isError && (
        <div className="text-xs text-red-500">{(createMut.error as Error).message}</div>
      )}
    </div>
  );
}

// ---- CLI 运行时表单（原 RuntimesTab 新建模态） ------------------------------

const EMPTY_RUNTIME_FORM = {
  interval_min: "",
  name: "",
  runtime: "",
  workdir: "",
  model: "",
  base_url: "",
  api_key: "",
  extra_env: "",
  instructions: "",
};

const inputCls =
  "w-full px-2.5 py-1.5 rounded-lg border border-line text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-ink-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

function RuntimeCard({
  active,
  onClick,
  label,
  icon: Glyph,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-2 rounded-lg border text-[11px] font-medium transition-colors ${
        active
          ? "border-accent bg-accent-soft text-accent-deep ring-1 ring-accent/40"
          : "border-line text-ink-muted hover:border-line-strong"
      }`}
    >
      <Glyph size={14} />
      {label}
    </button>
  );
}

/** Known project dirs seen in live sessions, freshest first — fills 工作目录
 * without typing a path. */
function useKnownProjectDirs(): string[] {
  const sessions = useSessions("all");
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sessions.data?.sessions ?? []) {
      if (!s.project_dir) continue;
      const prev = seen.get(s.project_dir);
      if (!prev || s.last_heartbeat_at > prev) seen.set(s.project_dir, s.last_heartbeat_at);
    }
    return [...seen.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 8)
      .map(([dir]) => dir);
  }, [sessions.data]);
}

function RuntimeCreateForm({ onClose }: { onClose: () => void }) {
  const create = useCreateRuntimeAgent();
  const runtimes = useRuntimes();
  const [form, setForm] = useState(EMPTY_RUNTIME_FORM);
  const [advanced, setAdvanced] = useState(false);
  const knownDirs = useKnownProjectDirs();
  const canBrowse = typeof window.confluxDesktop?.pickDirectory === "function";

  // Runtime choices come from the server's registry-derived catalog — adding
  // a runtime to RUNTIME_REGISTRY makes it appear here automatically.
  const runtimeCatalog = useMemo(
    () => Object.entries(runtimes.data?.runtimes ?? {}).map(([id, r]) => ({ id, label: r.label })),
    [runtimes.data],
  );

  // default to the first catalog entry once it loads
  useEffect(() => {
    if (!form.runtime && runtimeCatalog.length > 0) {
      set("runtime", runtimeCatalog[0].id);
    }
  }, [runtimeCatalog, form.runtime]);

  const set = <K extends keyof typeof EMPTY_RUNTIME_FORM>(k: K, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.name.trim() || create.isPending) return;
    create.mutate(
      {
        name: form.name,
        runtime: form.runtime,
        workdir: form.workdir || undefined,
        model: form.model || undefined,
        base_url: form.base_url || undefined,
        api_key: form.api_key || undefined,
        extra_env: form.extra_env || undefined,
        instructions: form.instructions || undefined,
        interval_min: form.interval_min.trim() ? Number(form.interval_min) : undefined,
      },
      { onSuccess: onClose },
    );
  };

  const pickDir = async () => {
    try {
      const dir = await window.confluxDesktop?.pickDirectory?.();
      if (dir) set("workdir", dir);
    } catch {
      // native dialog unavailable (browser stack) — manual input still works
    }
  };

  return (
    <>
      <div className="px-5 py-4 space-y-3">
        <Field label="名称 *">
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. api-worker"
            autoFocus
            className={inputCls}
          />
        </Field>
        <Field label="运行时 *">
          <div className="grid grid-cols-2 gap-1.5">
            {runtimeCatalog.map((r) => (
              <RuntimeCard
                key={r.id}
                active={form.runtime === r.id}
                onClick={() => set("runtime", r.id)}
                label={r.label}
                icon={runtimeGlyph(r.id)}
              />
            ))}
          </div>
        </Field>

        <Field label="工作目录(启动后 cd 到这里)">
          <div className="flex gap-1.5">
            <input
              value={form.workdir}
              onChange={(e) => set("workdir", e.target.value)}
              placeholder="C:\Project folder\项目\xxx"
              className={`${inputCls} flex-1 min-w-0`}
            />
            {canBrowse && (
              <button
                onClick={pickDir}
                className="flex items-center gap-1 px-2.5 rounded-lg border border-line text-xs text-ink-muted hover:bg-paper flex-shrink-0"
                title="浏览目录（桌面端）"
              >
                <Compass size={12} /> 浏览
              </button>
            )}
          </div>
          {knownDirs.length > 0 && (
            <div className="mt-1.5 space-y-1">
              <div className="text-[10px] text-ink-faint flex items-center gap-1 px-0.5">
                <Search size={9} /> 近期项目
              </div>
              <div className="flex flex-wrap gap-1">
                {knownDirs.map((dir) => (
                  <button
                    key={dir}
                    onClick={() => set("workdir", dir)}
                    title={dir}
                    className="max-w-full flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-paper border border-line text-ink-muted hover:border-accent/60 hover:text-accent"
                  >
                    <FolderOpen size={9} className="flex-shrink-0" />
                    <span className="truncate">{dir}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Field>

        <button
          onClick={() => setAdvanced((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink"
        >
          <ChevronDown
            size={12}
            className={`transition-transform ${advanced ? "rotate-180" : ""}`}
          />
          高级选项（模型 / API 渠道 / 定时 / 环境）
        </button>

        {advanced && (
          <div className="space-y-3 pt-1 border-t border-line">
            <div className="grid grid-cols-2 gap-3 pt-1">
              <Field label="模型(可选)">
                <input
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                  placeholder="claude-sonnet-4 / gpt-5-codex"
                  className={inputCls}
                />
              </Field>
              <Field label="API Base URL(可选,中转/代理)">
                <input
                  value={form.base_url}
                  onChange={(e) => set("base_url", e.target.value)}
                  placeholder="https://relay.example.com"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="API Key(可选,启动时注入环境变量,本地存储)">
                <input
                  type="password"
                  value={form.api_key}
                  onChange={(e) => set("api_key", e.target.value)}
                  placeholder="sk-..."
                  className={inputCls}
                />
              </Field>
              <Field label="定时间隔(分钟,可选)">
                <input
                  value={form.interval_min}
                  onChange={(e) => set("interval_min", e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="留空 = 仅手动启动"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="额外环境变量(JSON,可选)">
              <textarea
                value={form.extra_env}
                onChange={(e) => set("extra_env", e.target.value)}
                placeholder='{"HTTP_PROXY":"http://127.0.0.1:7890"}'
                rows={2}
                className={`${inputCls} font-mono text-[11px]`}
              />
            </Field>
            <Field label="系统指令(可选,--append-system-prompt)">
              <textarea
                value={form.instructions}
                onChange={(e) => set("instructions", e.target.value)}
                placeholder="你是一个只做 API 对接的后台 worker…"
                rows={3}
                className={inputCls}
              />
            </Field>
            <div className="text-[10px] text-ink-faint px-1">
              定时到点后 headless 唤醒(无窗口):查收件箱、处理待办、简报后退出。
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 px-5 py-3 border-t border-line sticky bottom-0 bg-white rounded-b-2xl">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-paper"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={!form.name.trim() || !form.runtime || create.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs hover:bg-accent-deep disabled:opacity-50"
        >
          {create.isPending && <Loader2 size={12} className="animate-spin" />}
          创建
        </button>
      </div>
      {create.isError && (
        <div className="text-xs text-red-600 px-5 pb-3">{(create.error as Error)?.message}</div>
      )}
    </>
  );
}
