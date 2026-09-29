import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTerminalSettings, useSaveTerminalSettings } from "../hooks";
import { api } from "../api";
import type { ConfluxDataBundle, TerminalChoice } from "@conflux/shared";
import { Settings, Loader2, Check, Download, Upload, Trash2 } from "lucide-react";
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

export function SettingsTab() {
  const { data, isLoading, error } = useTerminalSettings();
  const save = useSaveTerminalSettings();
  const queryClient = useQueryClient();
  const importInput = useRef<HTMLInputElement>(null);

  const [terminal, setTerminal] = useState<TerminalChoice>("wt");
  const [claudePath, setClaudePath] = useState("");
  const [codexPath, setCodexPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
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
    refreshClearCounts();
  }, []);

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
  }, [data]);

  const submit = () => {
    setNotice(null);
    save.mutate(
      { terminal, claude_path: claudePath, codex_path: codexPath },
      {
        onSuccess: () => setNotice("已保存"),
        onError: (e) => setNotice(`保存失败: ${(e as Error).message}`),
      },
    );
  };

  const refreshWorkspace = () => {
    for (const key of [
      "graph",
      "messages",
      "sessions-list",
      "agents",
      "runtimes",
      "peer-messages",
      "edge-messages",
      "peer-flow",
      "context",
    ]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
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
      refreshWorkspace();
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
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  const options = data?.options ?? [];
  const selected = options.find((o) => o.value === terminal);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-5">
        <div>
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3 shadow-sm">
          <h3 className="text-ink font-medium text-sm">主题</h3>
          <div>
            <p className="text-2xs text-ink-faint mb-2">明暗随色板自动切换——选深色色板即全站深色</p>
            <div className="grid grid-cols-2 gap-1.5">
              {allThemes.map((t) => {
                const active = activeCustom === t.name;
                return (
                  <button
                    key={t.name}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { setActiveCustomTheme(t.name); setActiveCustom(t.name); }}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-xs transition-colors ${
                      active ? "border-accent ring-1 ring-accent/30 text-ink" : "border-line text-ink-muted hover:border-line-strong"
                    }`}
                  >
                    <span className="flex gap-0.5 flex-shrink-0">
                      {[t.colors.accent, t.colors.paper, t.colors.line].map((c, i) => (
                        <span key={i} className="w-2.5 h-2.5 rounded-full border border-line" style={{ background: c }} />
                      ))}
                    </span>
                    <span className="truncate text-left flex-1">{t.name}</span>
                    {!BUILTIN_THEMES.some((b) => b.name === t.name) && (
                      <span
                        role="button"
                        title="删除此主题"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCustomTheme(t.name);
                          setCustomThemes(listCustomThemes());
                          if (activeCustom === t.name) { setActiveCustomTheme(null); setActiveCustom(null); }
                        }}
                        className="text-ink-faint hover:text-red-500 px-0.5"
                      >
                        ×
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-2.5">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={3}
                placeholder='导入主题 JSON：{"name":"我的主题","colors":{"ink":"#182234","paper":"#f6f7f9","line":"#e4e8ef","accent":"#2563eb",…}（8 键）}'
                className="w-full bg-surface text-ink text-xs rounded-lg px-2.5 py-2 border border-line placeholder-ink-faint outline-none focus:border-accent resize-y font-mono"
              />
              {importError && <div className="text-xs text-red-500 mt-1">{importError}</div>}
              <button
                type="button"
                onClick={applyImport}
                disabled={!importText.trim()}
                className="mt-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-line text-ink hover:border-accent hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed"
              >
                导入主题
              </button>
              <span className="text-2xs text-ink-faint ml-2">
                需要 name + 8 个 #rrggbb 颜色（ink/paper/surface/line/lineStrong/accent/accentDeep/accentSoft；次级文字色由 ink 自动派生）
              </span>
            </div>
          </div>
        </div>

          <h2 className="text-ink font-semibold text-base flex items-center gap-2">
            <Settings size={16} className="text-ink-muted" /> 设置
          </h2>
          <p className="text-xs text-ink-muted mt-0.5">
            「在终端打开」和运行时 agent 启动使用的终端与可执行文件。
          </p>
        </div>

        <div className="bg-surface border border-line rounded-xl p-4 space-y-4 shadow-sm">
          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1.5">终端打开方式</span>
            <select
              value={terminal}
              onChange={(e) => setTerminal(e.target.value as TerminalChoice)}
              className={selectCls}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.available ? "" : "(未安装,将回退)"}
                </option>
              ))}
            </select>
            {selected && (
              <span className="block text-2xs text-ink-faint mt-1.5">
                {selected.hint}
                {selected.available ? "" : " · 本机未检测到,保存后走回退链"}
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-2xs text-ink-muted mb-1">claude 可执行文件</span>
              <input
                value={claudePath}
                onChange={(e) => setClaudePath(e.target.value)}
                placeholder="claude"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="block text-2xs text-ink-muted mb-1">codex 可执行文件</span>
              <input
                value={codexPath}
                onChange={(e) => setCodexPath(e.target.value)}
                placeholder="codex"
                className={inputCls}
              />
            </label>
          </div>

          <div className="flex items-center justify-between pt-1">
            {notice ? (
              <span
                className={`text-xs ${
                  notice.startsWith("保存失败") ? "text-red-600" : "text-emerald-600"
                } flex items-center gap-1`}
              >
                {notice === "已保存" && <Check size={12} />}
                {notice}
              </span>
            ) : (
              <span />
            )}
            <button
              onClick={submit}
              disabled={save.isPending}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent text-white text-xs hover:bg-accent-deep disabled:opacity-50"
            >
              {save.isPending && <Loader2 size={12} className="animate-spin" />}
              保存
            </button>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-ink font-medium text-sm">数据备份</h3>
              <p className="text-2xs text-ink-faint mt-0.5">导出不包含 API key</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportWorkspace}
                disabled={transferPending}
                title="导出数据"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-ink text-xs hover:bg-tile-hover disabled:opacity-50"
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-ink text-xs hover:bg-tile-hover disabled:opacity-50"
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
                  ? "text-red-600"
                  : "text-emerald-600"
              } flex items-center gap-1`}
            >
              {!transferNotice.startsWith("导入失败") && !transferNotice.startsWith("导出失败") && (
                <Check size={12} />
              )}
              {transferNotice}
            </span>
          )}
        </div>

        <div className="bg-surface border border-line rounded-xl p-4 space-y-3 shadow-sm">
          <div>
            <h3 className="text-ink font-medium text-sm">数据清除</h3>
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
            <div key={key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-xs text-ink">{label}</span>
                <span className="text-2xs text-ink-faint ml-2 hidden sm:inline">{desc}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-2xs text-ink-faint tabular-nums">
                  {clearCounts ? countOf(key) : "—"}
                </span>
                <button
                  type="button"
                  onClick={() => runClear(key, label)}
                  disabled={clearPending || !clearCounts || countOf(key) === 0}
                  title={`清除${label}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs hover:bg-red-50 disabled:opacity-40"
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
                clearNotice.startsWith("清除失败") ? "text-red-600" : "text-emerald-600"
              } flex items-center gap-1`}
            >
              {!clearNotice.startsWith("清除失败") && <Check size={12} />}
              {clearNotice}
            </span>
          )}
        </div>

        <p className="text-2xs text-ink-faint">
          提示:可执行文件留空使用默认值(从 PATH 解析)。点击图上任意会话 →
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
