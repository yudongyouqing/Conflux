import { useEffect, useState } from "react";
import type { CliProbeEntry, RuntimeSettings } from "@conflux/shared";
import { RefreshCw, Save } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMicaStatus, useSettings } from "../hooks";
import { BUILTIN_THEMES, getActiveCustomThemeName } from "../theme";
import { RuntimeGlyph } from "./brand-icons";

interface SettingsViewProps {
  cliProbes: CliProbeEntry[];
  onSelectTheme: (themeName: string | null) => void;
}

export function SettingsView({ cliProbes, onSelectTheme }: SettingsViewProps) {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const micaStatus = useMicaStatus();

  const [form, setForm] = useState<RuntimeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeThemeName, setActiveThemeName] = useState<string>(
    () => getActiveCustomThemeName() ?? BUILTIN_THEMES[0].name,
  );

  useEffect(() => {
    if (settingsQuery.data?.settings && !form) {
      setForm(settingsQuery.data.settings);
    }
  }, [settingsQuery.data, form]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.saveSettings(form);
      setForm(res.settings);
      setNotice("配置已保存");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
      void qc.invalidateQueries({ queryKey: ["mica-status"] });
    } finally {
      setSaving(false);
    }
  };

  const handleReprobe = async () => {
    setProbing(true);
    try {
      await api.probeRuntimes(true);
      void qc.invalidateQueries({ queryKey: ["workspace-tree"] });
      void qc.invalidateQueries({ queryKey: ["mica-status"] });
      setNotice("已完成本机 CLI 探测");
    } finally {
      setProbing(false);
    }
  };

  return (
    <div data-testid="settings-view" className="flex-1 overflow-y-auto bg-surface px-6 py-6">
      <div className="mx-auto max-w-2xl space-y-8">
        <div className="flex items-center justify-between border-b border-line pb-4">
          <div>
            <h1 className="text-[15px] font-semibold text-ink">系统设置</h1>
            <p className="mt-0.5 text-xs text-ink-faint">
              主题色板、本机 CLI 引擎路径与自主互调防循环护栏。
            </p>
          </div>
          {notice && (
            <span className="rounded-md bg-success-soft px-2.5 py-1 text-2xs font-medium text-success">
              {notice}
            </span>
          )}
        </div>

        {/* Appearance */}
        <section className="space-y-3 border-b border-line pb-6">
          <div className="text-xs font-medium text-ink">界面主题</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {BUILTIN_THEMES.map((t) => {
              const selected = activeThemeName === t.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  data-testid={`theme-preset-${t.name}`}
                  onClick={() => {
                    setActiveThemeName(t.name);
                    onSelectTheme(t.name === BUILTIN_THEMES[0].name ? null : t.name);
                  }}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? "border-line-strong bg-tile-active font-semibold text-ink"
                      : "border-line bg-elev text-ink-muted hover:bg-tile-hover hover:text-ink"
                  }`}
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-line-strong"
                    style={{ background: t.colors.paper }}
                  />
                  <span className="truncate text-xs">{t.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Local CLIs & Guardrails */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink">本机 CLI 探测与路径</span>
            <button
              type="button"
              disabled={probing}
              onClick={() => void handleReprobe()}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-2xs text-ink-muted hover:bg-tile-hover hover:text-ink"
            >
              <RefreshCw className={`h-3 w-3 ${probing ? "animate-spin" : ""}`} />
              重新探测
            </button>
          </div>

          <div className="divide-y divide-line rounded-lg border border-line">
            {cliProbes.map((p) => (
              <div key={p.runtime} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <RuntimeGlyph runtime={p.runtime} size={14} className="shrink-0 text-ink-muted" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-ink">{p.label}</div>
                    <div className="truncate font-mono text-2xs text-ink-faint">
                      {p.resolved_path ?? (p.executable || "未配置（可选第三方 ACP CLI）")}
                    </div>
                  </div>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 text-2xs ${
                    p.available ? "text-success" : "text-ink-faint"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      p.available ? "bg-success" : "bg-neutral"
                    }`}
                  />
                  <span className="font-mono">{p.available ? (p.version ?? "可用") : "未配置"}</span>
                </span>
              </div>
            ))}
            <div
              data-testid="settings-mica-probe"
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center font-mono text-2xs text-ink-muted">
                  M
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink">Mica 终端</div>
                  <div className="truncate font-mono text-2xs text-ink-faint">
                    {micaStatus.data?.executable || form?.mica_path || "mica"}
                  </div>
                </div>
              </div>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 text-2xs ${
                  micaStatus.data?.available ? "text-success" : "text-ink-faint"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    micaStatus.data?.available ? "bg-success" : "bg-neutral"
                  }`}
                />
                <span className="font-mono">
                  {micaStatus.data?.available ? "已安装" : "未安装"}
                </span>
              </span>
            </div>
          </div>

          {form && (
            <form onSubmit={(e) => void handleSaveSettings(e)} className="space-y-3 pt-1">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(
                  [
                    ["antigravity_path", "Antigravity (agy) 路径", "agy"],
                    ["claude_path", "Claude Code 路径", "claude"],
                    ["codex_path", "Codex 路径", "codex"],
                    ["acp_path", "自定义第三方 ACP CLI（可选，留空不启用）", "例如：opencode 或 gemini"],
                    ["mica_path", "Mica 终端 CLI 路径（可选，未安装时内嵌终端不受影响）", "mica"],
                  ] as const
                ).map(([key, label, placeholder]) => (
                  <div key={key}>
                    <label className="mb-1 block text-2xs text-ink-muted">{label}</label>
                    <input
                      type="text"
                      value={form[key]}
                      placeholder={placeholder}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      className="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 font-mono text-xs text-ink focus:border-ink-muted focus:outline-none"
                    />
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-2xs text-ink-muted">
                    自主互调最大跳数（trace_id 上限）
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={form.max_autonomous_hops}
                    onChange={(e) =>
                      setForm({ ...form, max_autonomous_hops: Number(e.target.value) || 5 })
                    }
                    className="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 font-mono text-xs text-ink"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-2xs text-ink-muted">
                    同对 Agent 互调冷却 (ms)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={500}
                    value={form.pair_cooldown_ms}
                    onChange={(e) =>
                      setForm({ ...form, pair_cooldown_ms: Number(e.target.value) || 0 })
                    }
                    className="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 font-mono text-xs text-ink"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "保存中..." : "保存配置"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
