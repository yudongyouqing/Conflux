import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApplyCliProvider,
  useCliProviders,
  useDeleteCliProviderPreset,
  useSaveCliProviderPreset,
  useSaveTerminalSettings,
  useTerminalSettings,
} from "../hooks";
import { api } from "../api";
import type { ConfluxDataBundle, RuntimeId, TerminalChoice } from "@conflux/shared";
import {
  Settings,
  Loader2,
  Check,
  Download,
  Upload,
  Trash2,
  RefreshCw,
  Terminal,
  Plus,
  KeyRound,
  ArrowUpRight,
} from "lucide-react";
import { ClaudeIcon, OpenAIIcon } from "./brand-icons";
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
  const { data, isLoading, error, refetch: refetchTerminal, isFetching: probingTerminal } =
    useTerminalSettings(active);
  const save = useSaveTerminalSettings();
  const cliProviders = useCliProviders(active);
  const savePreset = useSaveCliProviderPreset();
  const deletePreset = useDeleteCliProviderPreset();
  const applyProvider = useApplyCliProvider();
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
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<"terminal" | "wake" | null>(null);
  const [addingPreset, setAddingPreset] = useState(false);
  const [presetForm, setPresetForm] = useState<{
    name: string;
    runtime: RuntimeId;
    base_url: string;
    model: string;
    api_key: string;
    extra_env: string;
  }>({
    name: "",
    runtime: "claude",
    base_url: "",
    model: "",
    api_key: "",
    extra_env: "",
  });
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const [transferPending, setTransferPending] = useState(false);
  const [importConflict, setImportConflict] = useState<"skip" | "overwrite" | "copy">("skip");

  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(() => listCustomThemes());
  const [activeCustom, setActiveCustom] = useState<string | null>(() => getActiveCustomThemeName());
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
    } catch {
      setImportError("JSON 解析失败");
    }
  };

  const allThemes: CustomTheme[] = [...BUILTIN_THEMES, ...customThemes];

  // load persisted values once available
  useEffect(() => {
    if (!data) return;
    setTerminal(data.terminal.terminal);
    setClaudePath(data.terminal.claude_path);
    setCodexPath(data.terminal.codex_path);
    setAutoWake(data.auto_wake ?? true);
    setWakeMaxConcurrent(data.wake_max_concurrent ?? 3);
    setWakeActiveCount(data.wake_active_count ?? 0);
  }, [data]);

  // Refresh wake active count every 3s
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api.getTerminalSettings().then((d) => {
        if (!cancelled) setWakeActiveCount(d.wake_active_count ?? 0);
      }).catch(() => {/* ignore */});
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active]);

  const submitTerminal = () => {
    setTerminalNotice(null);
    setSavingSection("terminal");
    save.mutate(
      {
        terminal,
        claude_path: claudePath,
        codex_path: codexPath,
      },
      {
        onSuccess: () => setTerminalNotice("已保存"),
        onError: (e) => setTerminalNotice(`保存失败: ${(e as Error).message}`),
        onSettled: () => setSavingSection((prev) => (prev === "terminal" ? null : prev)),
      },
    );
  };

  const submitWake = () => {
    setWakeNotice(null);
    setSavingSection("wake");
    save.mutate(
      {
        auto_wake: autoWake,
        wake_max_concurrent: wakeMaxConcurrent,
      },
      {
        onSuccess: () => setWakeNotice("已保存"),
        onError: (e) => setWakeNotice(`保存失败: ${(e as Error).message}`),
        onSettled: () => setSavingSection((prev) => (prev === "wake" ? null : prev)),
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
  const binaries = data?.binaries ?? [];
  const nativeProviders = cliProviders.data?.native ?? [];
  const providerPresets = cliProviders.data?.presets ?? [];

  const handleSavePreset = (andApply: boolean) => {
    const name = presetForm.name.trim();
    if (!name || savePreset.isPending || applyProvider.isPending) return;
    setProviderNotice(null);
    const trimmedKey = presetForm.api_key.trim() || null;
    savePreset.mutate(
      {
        name,
        runtime: presetForm.runtime,
        base_url: presetForm.base_url.trim() || null,
        model: presetForm.model.trim() || null,
        api_key: trimmedKey,
        extra_env: presetForm.extra_env.trim() || null,
      },
      {
        onSuccess: ({ preset }) => {
          setPresetForm({
            name: "",
            runtime: presetForm.runtime,
            base_url: "",
            model: "",
            api_key: "",
            extra_env: "",
          });
          setAddingPreset(false);
          if (andApply) {
            applyProvider.mutate(
              { preset_id: preset.id },
              {
                onSuccess: (res) =>
                  setProviderNotice(
                    `已写入 ${res.config_path}${res.backup_path ? "（已自动备份原文件）" : ""}`,
                  ),
                onError: (e) => setProviderNotice(`写入失败: ${(e as Error).message}`),
              },
            );
          } else {
            setProviderNotice(`已保存渠道预设「${preset.name}」`);
          }
        },
        onError: (e) => setProviderNotice(`保存失败: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-surface p-4 sm:p-7">
      <div className="max-w-2xl mx-auto divide-y divide-line/80">
        <div className="pb-5">
          <h2 className="text-ink font-semibold text-base-plus tracking-[-0.015em] flex items-center gap-2">
            <Settings size={16} className="text-accent" /> 设置
          </h2>
          <p className="text-xs text-ink-muted mt-1">
            主题外观、终端启动方式、自动唤醒并发控制与本地数据管理。
          </p>
        </div>

        <section className="py-6 space-y-3.5">
          <div>
            <h3 className="text-ink font-semibold text-sm tracking-[-0.01em]">外观与主题</h3>
            <p className="text-2xs text-ink-muted mt-0.5">明暗随色板切换，状态颜色保持 AA 对比度。</p>
          </div>
          <div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {allThemes.map((t) => {
                const active = (activeCustom ?? BUILTIN_THEMES[0].name) === t.name;
                const custom = !BUILTIN_THEMES.some((b) => b.name === t.name);
                return (
                  <div
                    key={t.name}
                    className={`flex items-center rounded-xl border transition-colors ${
                      active
                        ? "border-accent bg-accent-soft/60"
                        : "border-line/80 hover:border-line-strong bg-paper/40"
                    }`}
                  >
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => { setActiveCustomTheme(t.name); setActiveCustom(t.name); }}
                      className={`flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                        active ? "text-ink font-medium" : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="w-7 h-5 rounded-md border flex overflow-hidden flex-shrink-0"
                        style={{ background: t.colors.paper, borderColor: t.colors.line }}
                      >
                        <span className="w-2 h-full" style={{ background: t.colors.paper }} />
                        <span className="flex-1 h-full flex items-end p-0.5" style={{ background: t.colors.surface }}>
                          <span className="w-full h-1 rounded-full" style={{ background: t.colors.accent }} />
                        </span>
                      </span>
                      <span className="truncate text-left flex-1">{t.name}</span>
                      {active && <Check size={14} aria-hidden="true" className="text-accent shrink-0" />}
                    </button>
                    {custom && (
                      <button
                        type="button"
                        aria-label={`删除主题 ${t.name}`}
                        title="删除此主题"
                        onClick={() => {
                          deleteCustomTheme(t.name);
                          setCustomThemes(listCustomThemes());
                          if (activeCustom === t.name) { setActiveCustomTheme(null); setActiveCustom(null); }
                        }}
                        className="text-ink-muted hover:text-danger hover:bg-danger-soft rounded-md p-2 mr-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-3.5">
              <label htmlFor="theme-import" className="block text-xs text-ink-muted mb-1.5">导入自定义主题</label>
              <textarea
                id="theme-import"
                aria-invalid={!!importError}
                aria-describedby={importError ? "theme-import-error" : "theme-import-help"}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={3}
                placeholder='导入主题 JSON：{"name":"我的主题","colors":{"ink":"#111827","paper":"#f7f8fa","surface":"#ffffff","line":"#e6e8ee",…}（8 键）}'
                className="w-full bg-paper/50 text-ink text-xs rounded-lg px-3 py-2 border border-line placeholder-ink-faint outline-none focus:border-accent resize-y font-mono"
              />
              {importError && <div id="theme-import-error" role="alert" className="text-xs text-danger mt-1">{importError}</div>}
              <button
                type="button"
                onClick={applyImport}
                disabled={!importText.trim()}
                className="mt-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-line text-ink hover:border-accent hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                导入主题
              </button>
              <span id="theme-import-help" className="block text-2xs text-ink-faint mt-2">
                需要 name + 8 个 #rrggbb 颜色（ink/paper/surface/line/lineStrong/accent/accentDeep/accentSoft；次级文字色由 ink 自动派生）
              </span>
            </div>
          </div>
        </section>

        <section className="py-6 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-ink font-semibold text-sm tracking-[-0.01em]">终端与 CLI 环境</h3>
              <p className="text-2xs text-ink-faint mt-0.5">
                「在终端打开」与编码助手启动时使用的默认终端和本机 CLI 自动探测结果。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refetchTerminal()}
              disabled={probingTerminal}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-line text-2xs text-ink-muted hover:text-ink hover:bg-tile-hover disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={11} className={probingTerminal ? "animate-spin" : ""} />
              重新检测
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-ink">默认终端</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {options.map((o) => {
                const picked = terminal === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => setTerminal(o.value)}
                    className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                      picked
                        ? "border-accent bg-accent-soft/60"
                        : "border-line/80 bg-paper/40 hover:border-line-strong"
                    }`}
                  >
                    <Terminal
                      size={14}
                      className={`mt-0.5 flex-shrink-0 ${picked ? "text-accent" : "text-ink-faint"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-xs truncate ${picked ? "text-ink font-medium" : "text-ink-muted"}`}>
                          {o.label}
                        </span>
                        <span
                          className={`ml-auto text-2xs px-1.5 py-px rounded flex-shrink-0 ${
                            o.available
                              ? "bg-success-soft text-success"
                              : "bg-neutral-soft text-neutral"
                          }`}
                        >
                          {o.available ? "已就绪" : "未安装"}
                        </span>
                      </div>
                      <div className="text-2xs text-ink-faint truncate mt-0.5">{o.hint}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-ink">CLI 可执行文件</div>
            <div className="rounded-xl border border-line/80 divide-y divide-line/80 overflow-hidden bg-paper/30">
              {(
                [
                  {
                    runtime: "claude" as const,
                    label: "Claude Code",
                    Icon: ClaudeIcon,
                    value: claudePath,
                    onChange: setClaudePath,
                    placeholder: "claude",
                  },
                  {
                    runtime: "codex" as const,
                    label: "Codex",
                    Icon: OpenAIIcon,
                    value: codexPath,
                    onChange: setCodexPath,
                    placeholder: "codex",
                  },
                ] as const
              ).map(({ runtime, label, Icon, value, onChange, placeholder }) => {
                const probe = binaries.find((b) => b.runtime === runtime);
                const isEditing = editingBinary === runtime || (probe !== undefined && !probe.available);
                return (
                  <div key={runtime} className="p-3 space-y-2">
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-md bg-surface border border-line flex items-center justify-center flex-shrink-0 text-ink-muted">
                        <Icon size={13} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-ink">{label}</span>
                          {probe && (
                            <span
                              className={`text-2xs px-1.5 py-px rounded ${
                                probe.available
                                  ? "bg-success-soft text-success"
                                  : "bg-warning-soft text-warning"
                              }`}
                            >
                              {probe.available ? "已就绪" : "未检测到"}
                            </span>
                          )}
                        </div>
                        <div
                          className="text-2xs font-mono text-ink-faint truncate mt-0.5"
                          title={probe?.resolved_path ?? value ?? placeholder}
                        >
                          {probe?.resolved_path ?? (value.trim() || `${placeholder}（从 PATH 解析）`)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setEditingBinary((prev) => (prev === runtime ? null : runtime))
                        }
                        className="px-2 py-1 rounded-md text-2xs text-ink-muted hover:text-ink hover:bg-tile-hover border border-line/80 transition-colors flex-shrink-0"
                      >
                        {editingBinary === runtime ? "收起" : "自定义路径"}
                      </button>
                    </div>
                    {isEditing && (
                      <input
                        aria-label={`${runtime} 可执行文件`}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={`留空默认从 PATH 解析 (${placeholder})`}
                        className={`${inputCls} font-mono`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            {terminalNotice ? (
              <span
                className={`text-xs ${
                  terminalNotice.startsWith("保存失败") ? "text-danger" : "text-success"
                } flex items-center gap-1`}
              >
                {terminalNotice === "已保存" && <Check size={12} />}
                {terminalNotice}
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={submitTerminal}
              disabled={save.isPending}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-50 transition-colors"
            >
              {savingSection === "terminal" && <Loader2 size={12} className="animate-spin" />}
              保存
            </button>
          </div>
        </section>

        {/* CLI Provider presets & native config (~/.claude/settings.json, ~/.codex/config.toml) */}
        <section className="py-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-ink font-semibold text-sm tracking-[-0.01em]">
                模型渠道与本机配置
              </h3>
              <p className="text-2xs text-ink-faint mt-0.5">
                读取或一键写入本机 CLI 原生配置（自动备份原文件，兼容 CC-Switch / Magpie）。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAddingPreset((v) => !v)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-line text-2xs text-ink hover:border-accent hover:text-accent transition-colors flex-shrink-0"
            >
              <Plus size={12} /> 新建渠道预设
            </button>
          </div>

          {nativeProviders.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {nativeProviders.map((n) => (
                <div
                  key={n.runtime}
                  className="rounded-xl border border-line/80 bg-paper/40 p-3 space-y-1.5"
                >
                  <div className="flex items-center gap-2">
                    {n.runtime === "claude" ? (
                      <ClaudeIcon size={13} className="text-ink-muted" />
                    ) : (
                      <OpenAIIcon size={13} className="text-ink-muted" />
                    )}
                    <span className="text-xs font-medium text-ink">
                      {n.runtime === "claude" ? "Claude 原生配置" : "Codex 原生配置"}
                    </span>
                    <span
                      className={`ml-auto text-2xs px-1.5 py-px rounded ${
                        n.api_key_configured
                          ? "bg-success-soft text-success"
                          : "bg-neutral-soft text-neutral"
                      }`}
                    >
                      {n.api_key_configured ? "已配 Key" : n.exists ? "默认登录" : "未创建"}
                    </span>
                  </div>
                  <div className="text-2xs font-mono text-ink-faint truncate" title={n.config_path}>
                    {n.config_path}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                    <span>模型：{n.model || "默认"}</span>
                    {n.base_url && (
                      <span className="truncate font-mono text-ink-faint" title={n.base_url}>
                        · {n.base_url}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {addingPreset && (
            <div className="rounded-xl border border-line bg-paper/50 p-3.5 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="block text-2xs text-ink-muted mb-1">预设名称 *</span>
                  <input
                    value={presetForm.name}
                    onChange={(e) => setPresetForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="如：公司中转 / Magpie 本地网关"
                    className={inputCls}
                  />
                </label>
                <label className="block">
                  <span className="block text-2xs text-ink-muted mb-1">适用 CLI *</span>
                  <select
                    value={presetForm.runtime}
                    onChange={(e) =>
                      setPresetForm((f) => ({ ...f, runtime: e.target.value as RuntimeId }))
                    }
                    className={selectCls}
                  >
                    <option value="claude">Claude Code (~/.claude/settings.json)</option>
                    <option value="codex">Codex (~/.codex/config.toml)</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="block text-2xs text-ink-muted mb-1">Base URL</span>
                  <input
                    value={presetForm.base_url}
                    onChange={(e) => setPresetForm((f) => ({ ...f, base_url: e.target.value }))}
                    placeholder="https://relay.example.com"
                    className={`${inputCls} font-mono`}
                  />
                </label>
                <label className="block">
                  <span className="block text-2xs text-ink-muted mb-1">默认模型</span>
                  <input
                    value={presetForm.model}
                    onChange={(e) => setPresetForm((f) => ({ ...f, model: e.target.value }))}
                    placeholder={
                      presetForm.runtime === "claude" ? "claude-sonnet-4-5" : "gpt-5-codex"
                    }
                    className={`${inputCls} font-mono`}
                  />
                </label>
              </div>
              <label className="block">
                <span className="block text-2xs text-ink-muted mb-1">API Key（本地安全存储，响应脱敏）</span>
                <input
                  type="password"
                  value={presetForm.api_key}
                  onChange={(e) => setPresetForm((f) => ({ ...f, api_key: e.target.value }))}
                  placeholder="sk-..."
                  className={`${inputCls} font-mono`}
                />
              </label>
              {presetForm.runtime === "claude" && (
                <label className="block">
                  <span className="block text-2xs text-ink-muted mb-1">额外 env JSON（可选，兼容 CC-Switch 块）</span>
                  <textarea
                    rows={2}
                    value={presetForm.extra_env}
                    onChange={(e) => setPresetForm((f) => ({ ...f, extra_env: e.target.value }))}
                    placeholder='{"HTTP_PROXY":"http://127.0.0.1:7890"}'
                    className={`${inputCls} font-mono`}
                  />
                </label>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setAddingPreset(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-tile-hover"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!presetForm.name.trim() || savePreset.isPending}
                  onClick={() => handleSavePreset(false)}
                  className="px-3 py-1.5 rounded-lg border border-line text-xs text-ink hover:bg-tile-hover disabled:opacity-40"
                >
                  仅保存预设
                </button>
                <button
                  type="button"
                  disabled={!presetForm.name.trim() || savePreset.isPending || applyProvider.isPending}
                  onClick={() => handleSavePreset(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-40"
                >
                  <ArrowUpRight size={12} /> 保存并写入本机
                </button>
              </div>
            </div>
          )}

          {providerPresets.length > 0 && (
            <div className="rounded-xl border border-line/80 divide-y divide-line/80 overflow-hidden">
              {providerPresets.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 bg-surface hover:bg-tile/40 transition-colors"
                >
                  <KeyRound size={13} className="text-ink-faint flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-ink truncate">{p.name}</span>
                      <span className="text-2xs font-mono px-1.5 py-px rounded bg-tile text-ink-muted">
                        {p.runtime}
                      </span>
                      {p.api_key_configured && (
                        <span className="text-2xs px-1.5 py-px rounded bg-success-soft text-success">
                          Key 已存
                        </span>
                      )}
                    </div>
                    <div className="text-2xs font-mono text-ink-faint truncate mt-0.5">
                      {[p.model, p.base_url].filter(Boolean).join(" · ") || "仅环境变量"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      disabled={applyProvider.isPending}
                      onClick={() => {
                        setProviderNotice(null);
                        applyProvider.mutate(
                          { preset_id: p.id },
                          {
                            onSuccess: (res) =>
                              setProviderNotice(
                                `已写入 ${res.config_path}${res.backup_path ? "（已自动备份）" : ""}`,
                              ),
                            onError: (e) => setProviderNotice(`写入失败: ${(e as Error).message}`),
                          },
                        );
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-line text-2xs text-ink hover:border-accent hover:text-accent disabled:opacity-40 transition-colors"
                    >
                      <ArrowUpRight size={11} /> 写入本机配置
                    </button>
                    <button
                      type="button"
                      disabled={deletePreset.isPending}
                      onClick={() => deletePreset.mutate(p.id)}
                      title="删除预设"
                      className="p-1 rounded-md text-ink-faint hover:text-danger hover:bg-danger-soft transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {providerNotice && (
            <div
              className={`text-xs flex items-center gap-1 ${
                providerNotice.includes("失败") ? "text-danger" : "text-success"
              }`}
            >
              {!providerNotice.includes("失败") && <Check size={12} />}
              <span className="truncate">{providerNotice}</span>
            </div>
          )}
        </section>

        {/* Wake concurrency control: caps simultaneous headless wakes */}
        <section className="py-6 space-y-4">
          <div>
            <h3 className="text-ink font-semibold text-sm tracking-[-0.01em]">唤醒控制</h3>
            <p className="text-2xs text-ink-faint mt-0.5">
              自动唤醒会话响应消息，限制并发数量防止资源耗尽
            </p>
          </div>

          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div>
              <span className="text-xs font-medium text-ink">自动唤醒</span>
              <p className="text-2xs text-ink-faint mt-0.5">
                关闭后消息将保持待处理状态，需手动打开会话处理
              </p>
            </div>
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={autoWake}
                onChange={(e) => setAutoWake(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-line peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-accent/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-line after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent"></div>
            </span>
          </label>

          <label className="block">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-ink">最大并发唤醒数</span>
              <span className="text-xs text-ink-muted font-mono tabular-nums">
                {wakeMaxConcurrent === 0 ? "无限制" : wakeMaxConcurrent}
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="10"
              step="1"
              value={wakeMaxConcurrent}
              onChange={(e) => setWakeMaxConcurrent(Number(e.target.value))}
              disabled={!autoWake}
              className="w-full h-1.5 bg-line rounded-lg appearance-none cursor-pointer accent-accent disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-2xs text-ink-faint tabular-nums">
                0 = 无限制 · 当前活跃：{wakeActiveCount}
              </span>
              <span className="text-2xs text-ink-faint">
                推荐 3-5，避免资源耗尽
              </span>
            </div>
          </label>

          <div className="flex items-center justify-between pt-1">
            {wakeNotice ? (
              <span
                className={`text-xs ${
                  wakeNotice.startsWith("保存失败") ? "text-danger" : "text-success"
                } flex items-center gap-1`}
              >
                {wakeNotice === "已保存" && <Check size={12} />}
                {wakeNotice}
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={submitWake}
              disabled={save.isPending}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent text-on-accent text-xs font-medium hover:bg-accent-deep disabled:opacity-50 transition-colors"
            >
              {savingSection === "wake" && <Loader2 size={12} className="animate-spin" />}
              保存
            </button>
          </div>
        </section>

        <section className="py-6 space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-ink font-semibold text-sm tracking-[-0.01em]">数据备份</h3>
              <p className="text-2xs text-ink-faint mt-0.5">导出不包含 API key 与敏感环境变量</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportWorkspace}
                disabled={transferPending}
                title="导出数据"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-ink text-xs hover:bg-tile-hover disabled:opacity-50 transition-colors"
              >
                {transferPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                导出
              </button>
              <button
                type="button"
                onClick={() => importInput.current?.click()}
                disabled={transferPending}
                title="导入 JSON 数据"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-ink text-xs hover:bg-tile-hover disabled:opacity-50 transition-colors"
              >
                <Upload size={13} />
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
          <div className="flex items-center justify-between gap-3">
            <label className="text-2xs text-ink-muted" htmlFor="import-conflict">
              冲突处理
            </label>
            <select
              id="import-conflict"
              value={importConflict}
              onChange={(e) => setImportConflict(e.target.value as typeof importConflict)}
              className={selectCls + " max-w-48"}
              disabled={transferPending}
            >
              <option value="skip">跳过本地记录</option>
              <option value="overwrite">覆盖本地记录</option>
              <option value="copy">复制为新记录</option>
            </select>
          </div>
          {transferNotice && (
            <span
              className={`text-xs ${
                transferNotice.startsWith("导入失败") || transferNotice.startsWith("导出失败")
                  ? "text-danger"
                  : "text-success"
              } flex items-center gap-1`}
            >
              {!transferNotice.startsWith("导入失败") && !transferNotice.startsWith("导出失败") && (
                <Check size={12} />
              )}
              {transferNotice}
            </span>
          )}
        </section>

        <section className="py-6 space-y-3">
          <div>
            <h3 className="text-ink font-semibold text-sm tracking-[-0.01em]">数据清除</h3>
            <p className="text-2xs text-ink-faint mt-0.5">
              这些都是原会话上下文的本地副本。清除前自动备份全量数据（服务端保留最近 5
              份），可用上方「导入 JSON」恢复
            </p>
          </div>
          {(
            [
              ["sessions", "会话节点", "级联清除其消息与上下文，web-console 保留"],
              ["messages", "消息", "跨会话问答记录，会话节点保留"],
              ["context", "上下文笔记", "已发布的共享上下文"],
            ] as const
          ).map(([key, label, desc]) => (
            <div key={key} className="flex items-center justify-between gap-3 py-1">
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
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-danger/40 text-danger text-xs hover:bg-danger-soft disabled:opacity-40 transition-colors"
                >
                  {clearPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  清除
                </button>
              </div>
            </div>
          ))}
          {clearNotice && (
            <span
              className={`text-xs ${
                clearNotice.startsWith("清除失败") ? "text-danger" : "text-success"
              } flex items-center gap-1`}
            >
              {!clearNotice.startsWith("清除失败") && <Check size={12} />}
              {clearNotice}
            </span>
          )}
        </section>

        <p className="pt-5 text-2xs text-ink-faint">
          提示：可执行文件留空使用默认值（从 PATH 解析）。点击图上任意会话 →
          右侧面板「在终端打开」即可在新终端窗口 resume 该对话。
        </p>
      </div>
    </div>
  );
}

const inputCls =
  "w-full px-2.5 py-1.5 rounded-lg border border-line text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-surface";
const selectCls =
  "w-full px-2.5 py-2 rounded-lg border border-line text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-surface cursor-pointer";
