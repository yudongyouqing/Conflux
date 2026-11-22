import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCliProviders,
  useSaveTerminalSettings,
  useTerminalSettings,
} from "../hooks";
import { api } from "../api";
import type { ConfluxDataBundle, RuntimeId, TerminalChoice } from "@conflux/shared";
import {
  Loader2,
  Check,
  Download,
  Upload,
  Trash2,
  RefreshCw,
} from "lucide-react";
import {
  BUILTIN_THEMES,
  deleteCustomTheme,
  getActiveCustomThemeName,
  listCustomThemes,
  normalizeThemeColors,
  saveCustomTheme,
  setActiveCustomTheme,
  type CustomTheme,
} from "../theme";

export function SettingsTab({ active = true }: { active?: boolean }) {
  const {
    data,
    isLoading,
    error,
    refetch: refetchTerminal,
    isFetching: probingTerminal,
  } = useTerminalSettings(active);
  const save = useSaveTerminalSettings();
  const cliProviders = useCliProviders(active);
  const queryClient = useQueryClient();
  const importInput = useRef<HTMLInputElement>(null);

  const [terminal, setTerminal] = useState<TerminalChoice>("wt");
  const [claudePath, setClaudePath] = useState("");
  const [codexPath, setCodexPath] = useState("");
  const [editingBinary, setEditingBinary] = useState<RuntimeId | null>(null);
  const [autoWake, setAutoWake] = useState(true);
  const [wakeMaxConcurrent, setWakeMaxConcurrent] = useState(3);
  const [wakeActiveCount, setWakeActiveCount] = useState(0);
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const [wakeNotice, setWakeNotice] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const [transferPending, setTransferPending] = useState(false);
  const [importConflict, setImportConflict] = useState<"skip" | "overwrite" | "copy">("skip");

  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(() => listCustomThemes());
  const [activeCustom, setActiveCustom] = useState<string | null>(() => getActiveCustomThemeName());
  const [showThemeImport, setShowThemeImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [clearCounts, setClearCounts] = useState<{
    sessions: number;
    messages: number;
    contextEntries: number;
  } | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [clearNotice, setClearNotice] = useState<string | null>(null);

  const refreshClearCounts = () =>
    api
      .dataCounts()
      .then(setClearCounts)
      .catch(() => setClearCounts(null));
  useEffect(() => {
    if (active) void refreshClearCounts();
  }, [active]);

  type ClearKey = "sessions" | "messages" | "context";
  const countOf = (key: ClearKey): number =>
    clearCounts === null ? 0 : key === "context" ? clearCounts.contextEntries : clearCounts[key];

  const runClear = async (key: ClearKey, label: string) => {
    const n = countOf(key);
    const scopeText =
      key === "sessions"
        ? "其消息与上下文笔记将一并清除，图谱节点保留 web-console"
        : key === "messages"
          ? "跨会话消息记录将清除，会话节点保留"
          : "已发布的共享上下文笔记将清除";
    if (
      !window.confirm(
        `清除${label}（${n} 条）？\n${scopeText}。\n\n清除前会自动备份全量数据（服务端保留最近 5 份），之后可通过「导入 JSON」恢复。`,
      )
    ) {
      return;
    }
    setClearPending(true);
    setClearNotice(null);
    try {
      const r = await api.dataClear({ [key]: true });
      const clearedN = key === "context" ? r.cleared.contextEntries : r.cleared[key];
      setClearNotice(`已清除 ${clearedN} 条 · 备份：${r.backupPath ?? "无"}`);
      await refreshClearCounts();
      queryClient.invalidateQueries();
    } catch (err) {
      setClearNotice(`清除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClearPending(false);
    }
  };

  const applyImport = () => {
    try {
      const parsed = JSON.parse(importText) as unknown;
      const colors = normalizeThemeColors((parsed as CustomTheme)?.colors);
      const rawName = (parsed as CustomTheme)?.name;
      const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
      if (!colors || !name) {
        setImportError("格式无效：需要 name 与全部 8 个 #rrggbb 颜色");
        return;
      }
      if (BUILTIN_THEMES.some((b) => b.name === name)) {
        setImportError("不能与内置主题重名");
        return;
      }
      saveCustomTheme({ name, colors });
      setCustomThemes(listCustomThemes());
      setActiveCustomTheme(name);
      setActiveCustom(name);
      setImportText("");
      setImportError(null);
      setShowThemeImport(false);
    } catch {
      setImportError("JSON 解析失败");
    }
  };

  const allThemes: CustomTheme[] = [...BUILTIN_THEMES, ...customThemes];

  useEffect(() => {
    if (!data) return;
    setTerminal(data.terminal.terminal);
    setClaudePath(data.terminal.claude_path);
    setCodexPath(data.terminal.codex_path);
    setAutoWake(data.auto_wake ?? true);
    setWakeMaxConcurrent(data.wake_max_concurrent ?? 3);
    setWakeActiveCount(data.wake_active_count ?? 0);
  }, [data]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api
        .getTerminalSettings()
        .then((d) => {
          if (!cancelled) setWakeActiveCount(d.wake_active_count ?? 0);
        })
        .catch(() => {
          /* ignore */
        });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  const persistTerminal = (next: {
    terminal?: TerminalChoice;
    claude_path?: string;
    codex_path?: string;
  }) => {
    setTerminalNotice(null);
    save.mutate(
      {
        terminal: next.terminal ?? terminal,
        claude_path: next.claude_path ?? claudePath,
        codex_path: next.codex_path ?? codexPath,
      },
      {
        onSuccess: () => {
          setTerminalNotice("已保存");
          setEditingBinary(null);
        },
        onError: (e) => setTerminalNotice(`保存失败: ${(e as Error).message}`),
      },
    );
  };

  const persistWake = (next: { auto_wake?: boolean; wake_max_concurrent?: number }) => {
    setWakeNotice(null);
    save.mutate(
      {
        auto_wake: next.auto_wake ?? autoWake,
        wake_max_concurrent: next.wake_max_concurrent ?? wakeMaxConcurrent,
      },
      {
        onSuccess: () => setWakeNotice("已保存"),
        onError: (e) => setWakeNotice(`保存失败: ${(e as Error).message}`),
      },
    );
  };

  const refreshWorkspace = async () => {
    await Promise.all([queryClient.invalidateQueries(), refreshClearCounts()]);
  };

  const exportWorkspace = async () => {
    setTransferPending(true);
    setTransferNotice(null);
    try {
      const bundle = await api.exportData("global");
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `conflux-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setTransferNotice("数据已导出");
    } catch (e) {
      setTransferNotice(`导出失败: ${(e as Error).message}`);
    } finally {
      setTransferPending(false);
    }
  };

  const importWorkspace = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setTransferPending(true);
    setTransferNotice(null);
    try {
      const bundle = JSON.parse(await file.text()) as Partial<ConfluxDataBundle>;
      const counts = [
        ["会话", bundle.sessions?.length ?? 0],
        ["上下文", bundle.context_entries?.length ?? 0],
        ["消息", bundle.messages?.length ?? 0],
        ["智能体", bundle.agents?.length ?? 0],
      ];
      const summary = counts.map(([label, count]) => `${label} ${count}`).join(", ");
      const confirmed = window.confirm(
        `导入 ${bundle.format ?? "未知格式"} v${bundle.version ?? "?"}（${summary}）？\n冲突策略：${importConflict}`,
      );
      if (!confirmed) return;

      const result = await api.importData(bundle as ConfluxDataBundle, importConflict);
      await refreshWorkspace();
      setTransferNotice(
        `导入完成: 新增 ${result.imported}, 覆盖 ${result.overwritten}, 复制 ${result.copied}, 跳过 ${result.skipped}`,
      );
    } catch (e) {
      setTransferNotice(`导入失败: ${(e as Error).message}`);
    } finally {
      setTransferPending(false);
    }
  };

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-ink-faint text-sm">
        加载设置...
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-full text-danger text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  const options = data?.options ?? [];
  const selectedTerminal = options.find((o) => o.value === terminal);
  const binaries = data?.binaries ?? [];
  const nativeProviders = cliProviders.data?.native ?? [];

  return (
    <div className="h-full overflow-y-auto bg-surface px-5 py-6 sm:px-8 sm:py-8">
      <div className="max-w-[640px] mx-auto divide-y divide-line/60">
        <header className="pb-5">
          <h2 className="text-ink font-semibold text-base-plus tracking-[-0.015em]">设置</h2>
        </header>

        {/* 外观与主题 */}
        <section className="py-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className={sectionTitleCls}>外观</h3>
            <button
              type="button"
              onClick={() => setShowThemeImport((v) => !v)}
              className={quietBtnCls}
            >
              {showThemeImport ? "收起" : "导入主题"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {allThemes.map((t) => {
              const isCurrent = (activeCustom ?? BUILTIN_THEMES[0].name) === t.name;
              const custom = !BUILTIN_THEMES.some((b) => b.name === t.name);
              return (
                <div
                  key={t.name}
                  className={`inline-flex items-center rounded-lg border transition-colors ${
                    isCurrent
                      ? "border-accent bg-accent-soft/60"
                      : "border-line/80 hover:border-line-strong"
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={isCurrent}
                    onClick={() => {
                      setActiveCustomTheme(t.name);
                      setActiveCustom(t.name);
                    }}
                    className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                      isCurrent ? "text-ink font-medium" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="w-3 h-3 rounded-full border flex-shrink-0"
                      style={{
                        background: `linear-gradient(135deg, ${t.colors.paper} 50%, ${t.colors.accent} 50%)`,
                        borderColor: t.colors.line,
                      }}
                    />
                    <span>{t.name}</span>
                  </button>
                  {custom && (
                    <button
                      type="button"
                      aria-label={`删除主题 ${t.name}`}
                      title="删除此主题"
                      onClick={() => {
                        deleteCustomTheme(t.name);
                        setCustomThemes(listCustomThemes());
                        if (activeCustom === t.name) {
                          setActiveCustomTheme(null);
                          setActiveCustom(null);
                        }
                      }}
                      className="text-ink-faint hover:text-danger p-1.5 mr-0.5 rounded"
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {showThemeImport && (
            <div className="pt-1 space-y-2">
              <textarea
                id="theme-import"
                aria-label="导入自定义主题"
                aria-invalid={!!importError}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={2}
                placeholder='{"name":"我的主题","colors":{"ink":"#111827","paper":"#f7f8fa",...}}'
                className={`${inputCls} font-mono resize-y`}
              />
              {importError && (
                <div role="alert" className="text-2xs text-danger">
                  {importError}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-ink-faint">需包含 name 与 8 个 #rrggbb 色值</span>
                <button
                  type="button"
                  onClick={applyImport}
                  disabled={!importText.trim()}
                  className={outlineBtnCls}
                >
                  应用
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 终端与 CLI */}
        <section className="py-5 space-y-1">
          <div className="flex items-center justify-between gap-3 pb-1.5">
            <div className="flex items-center gap-2">
              <h3 className={sectionTitleCls}>终端与 CLI</h3>
              {terminalNotice && (
                <span
                  className={`text-2xs inline-flex items-center gap-1 ${
                    terminalNotice.startsWith("保存失败") ? "text-danger" : "text-success"
                  }`}
                >
                  {terminalNotice === "已保存" && <Check size={11} />}
                  {terminalNotice}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void refetchTerminal()}
              disabled={probingTerminal}
              className={quietBtnCls}
            >
              <RefreshCw size={11} className={probingTerminal ? "animate-spin" : ""} />
              重新检测
            </button>
          </div>

          <div className="divide-y divide-line/50">
            <div className="flex items-center justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <label htmlFor="default-terminal" className="text-xs font-medium text-ink">
                  默认终端
                </label>
                {selectedTerminal?.hint && (
                  <p className="text-2xs text-ink-faint truncate mt-0.5">{selectedTerminal.hint}</p>
                )}
              </div>
              <select
                id="default-terminal"
                value={terminal}
                disabled={save.isPending}
                onChange={(e) => {
                  const next = e.target.value as TerminalChoice;
                  setTerminal(next);
                  persistTerminal({ terminal: next });
                }}
                className={`${selectCls} w-48 sm:w-56 flex-shrink-0`}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {o.available ? "" : "（未安装）"}
                  </option>
                ))}
              </select>
            </div>

            {(
              [
                {
                  runtime: "claude" as const,
                  label: "Claude Code",
                  value: claudePath,
                  onChange: setClaudePath,
                  placeholder: "claude",
                },
                {
                  runtime: "codex" as const,
                  label: "Codex",
                  value: codexPath,
                  onChange: setCodexPath,
                  placeholder: "codex",
                },
              ] as const
            ).map(({ runtime, label, value, onChange, placeholder }) => {
              const probe = binaries.find((b) => b.runtime === runtime);
              const isEditing = editingBinary === runtime;
              return (
                <div key={runtime} className="py-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            probe?.available === false ? "bg-warning" : "bg-success"
                          }`}
                        />
                        <span className="text-xs font-medium text-ink">{label}</span>
                        {probe && !probe.available && (
                          <span className="text-2xs text-warning">未检测到</span>
                        )}
                      </div>
                      <p
                        className="text-2xs font-mono text-ink-faint truncate mt-0.5 pl-3.5"
                        title={probe?.resolved_path ?? (value || placeholder)}
                      >
                        {probe?.resolved_path ?? (value.trim() || `${placeholder}（PATH）`)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setEditingBinary((prev) => (prev === runtime ? null : runtime))
                      }
                      className={quietBtnCls}
                    >
                      {isEditing ? "取消" : "自定义"}
                    </button>
                  </div>
                  {isEditing && (
                    <div className="flex items-center gap-2 pl-3.5">
                      <input
                        aria-label={`${runtime} 可执行文件`}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            persistTerminal(
                              runtime === "claude"
                                ? { claude_path: value }
                                : { codex_path: value },
                            );
                          }
                        }}
                        placeholder={`留空默认从 PATH 解析 (${placeholder})`}
                        className={`${inputCls} font-mono`}
                      />
                      <button
                        type="button"
                        disabled={save.isPending}
                        onClick={() =>
                          persistTerminal(
                            runtime === "claude"
                              ? { claude_path: value }
                              : { codex_path: value },
                          )
                        }
                        className={outlineBtnCls}
                      >
                        保存
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 本机 CLI 配置（只读展示，渠道切换交由 CC-Switch 等工具管理） */}
        <section className="py-5 space-y-1">
          <div className="flex items-center justify-between gap-3 pb-1.5">
            <h3 className={sectionTitleCls}>本机 CLI 配置</h3>
            <span className="text-2xs text-ink-faint">只读 · 由本机配置 / CC-Switch 管理</span>
          </div>

          <div className="divide-y divide-line/50">
            {nativeProviders.map((n) => (
              <div key={n.runtime} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      n.api_key_configured ? "bg-success" : "bg-ink-faint/40"
                    }`}
                  />
                  <span className="text-xs font-medium text-ink">
                    {n.runtime === "claude" ? "Claude" : "Codex"}
                  </span>
                  <span className="text-2xs text-ink-muted truncate">
                    {[n.model || "默认模型", n.base_url].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span
                  className="text-2xs font-mono text-ink-faint truncate max-w-[190px] flex-shrink-0"
                  title={n.config_path}
                >
                  {n.runtime === "claude" ? "~/.claude/settings.json" : "~/.codex/config.toml"}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* 唤醒控制 */}
        <section className="py-5 space-y-1">
          <div className="flex items-center gap-2 pb-1.5">
            <h3 className={sectionTitleCls}>唤醒控制</h3>
            {wakeNotice && (
              <span
                className={`text-2xs inline-flex items-center gap-1 ${
                  wakeNotice.startsWith("保存失败") ? "text-danger" : "text-success"
                }`}
              >
                {wakeNotice === "已保存" && <Check size={11} />}
                {wakeNotice}
              </span>
            )}
          </div>
          <div className="divide-y divide-line/50">
            <label className="flex items-center justify-between gap-4 py-2.5 cursor-pointer">
              <div>
                <span className="text-xs font-medium text-ink">自动唤醒</span>
                <p className="text-2xs text-ink-faint mt-0.5">
                  关闭后新消息保持待处理，需手动打开会话
                </p>
              </div>
              <span className="relative inline-flex items-center flex-shrink-0">
                <input
                  type="checkbox"
                  checked={autoWake}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setAutoWake(next);
                    persistWake({ auto_wake: next });
                  }}
                  className="sr-only peer"
                />
                <div className="w-8 h-[18px] bg-line peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-accent/30 rounded-full peer peer-checked:after:translate-x-3.5 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-accent" />
              </span>
            </label>

            <div className="flex items-center justify-between gap-4 py-2.5">
              <div>
                <label htmlFor="wake-max-concurrent" className="text-xs font-medium text-ink">
                  最大并发数
                </label>
                <p className="text-2xs text-ink-faint mt-0.5 tabular-nums">
                  当前活跃 {wakeActiveCount} · 推荐 3–5
                </p>
              </div>
              <select
                id="wake-max-concurrent"
                value={wakeMaxConcurrent}
                disabled={!autoWake || save.isPending}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setWakeMaxConcurrent(next);
                  persistWake({ wake_max_concurrent: next });
                }}
                className={`${selectCls} w-28 flex-shrink-0 disabled:opacity-50`}
              >
                <option value={0}>无限制</option>
                {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} 个
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* 数据备份 */}
        <section className="py-5 space-y-1">
          <div className="flex items-center gap-2 pb-1.5">
            <h3 className={sectionTitleCls}>数据备份</h3>
            {transferNotice && (
              <span
                className={`text-2xs inline-flex items-center gap-1 ${
                  transferNotice.startsWith("导入失败") || transferNotice.startsWith("导出失败")
                    ? "text-danger"
                    : "text-success"
                }`}
              >
                {!transferNotice.startsWith("导入失败") &&
                  !transferNotice.startsWith("导出失败") && <Check size={11} />}
                {transferNotice}
              </span>
            )}
          </div>
          <div className="divide-y divide-line/50">
            <div className="flex items-center justify-between gap-4 py-2.5">
              <div>
                <span className="text-xs font-medium text-ink">导出 / 导入</span>
                <p className="text-2xs text-ink-faint mt-0.5">导出不包含 API Key 与敏感变量</p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={exportWorkspace}
                  disabled={transferPending}
                  title="导出数据"
                  className={outlineBtnCls}
                >
                  {transferPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  导出
                </button>
                <button
                  type="button"
                  onClick={() => importInput.current?.click()}
                  disabled={transferPending}
                  title="导入 JSON 数据"
                  className={outlineBtnCls}
                >
                  <Upload size={12} />
                  导入 JSON
                </button>
                <input
                  ref={importInput}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={importWorkspace}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 py-2.5">
              <label className="text-xs font-medium text-ink" htmlFor="import-conflict">
                导入冲突策略
              </label>
              <select
                id="import-conflict"
                value={importConflict}
                onChange={(e) => setImportConflict(e.target.value as typeof importConflict)}
                className={`${selectCls} w-40 flex-shrink-0`}
                disabled={transferPending}
              >
                <option value="skip">跳过本地记录</option>
                <option value="overwrite">覆盖本地记录</option>
                <option value="copy">复制为新记录</option>
              </select>
            </div>
          </div>
        </section>

        {/* 数据清除 */}
        <section className="py-5 space-y-1">
          <div className="flex items-center gap-2 pb-1.5">
            <h3 className={sectionTitleCls}>数据清除</h3>
            {clearNotice && (
              <span
                className={`text-2xs inline-flex items-center gap-1 ${
                  clearNotice.startsWith("清除失败") ? "text-danger" : "text-success"
                }`}
              >
                {!clearNotice.startsWith("清除失败") && <Check size={11} />}
                {clearNotice}
              </span>
            )}
          </div>
          <div className="divide-y divide-line/50">
            {(
              [
                ["sessions", "会话节点", "级联清除其消息与上下文"],
                ["messages", "消息", "跨会话问答记录"],
                ["context", "上下文笔记", "共享上下文"],
              ] as const
            ).map(([key, label, desc]) => (
              <div key={key} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <span className="text-xs font-medium text-ink">{label}</span>
                  <span className="text-2xs text-ink-faint ml-2 hidden sm:inline">{desc}</span>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="text-2xs font-mono text-ink-faint tabular-nums">
                    {clearCounts ? countOf(key) : "—"}
                  </span>
                  <button
                    type="button"
                    onClick={() => runClear(key, label)}
                    disabled={clearPending || !clearCounts || countOf(key) === 0}
                    title={`清除${label}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-danger/30 text-danger text-2xs hover:bg-danger-soft disabled:opacity-40 transition-colors"
                  >
                    清除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

const sectionTitleCls = "text-2xs font-semibold uppercase tracking-[0.04em] text-ink-muted";
const inputCls =
  "w-full px-2.5 py-1.5 rounded-md border border-line text-xs text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-surface";
const selectCls =
  "px-2.5 py-1.5 rounded-md border border-line text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-surface cursor-pointer";
const outlineBtnCls =
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-line text-2xs text-ink hover:border-line-strong hover:bg-tile-hover disabled:opacity-40 transition-colors flex-shrink-0";
const quietBtnCls =
  "inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs text-ink-muted hover:text-ink hover:bg-tile-hover disabled:opacity-40 transition-colors flex-shrink-0";
