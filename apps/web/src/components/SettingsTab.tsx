import { useEffect, useState } from "react";
import { useTerminalSettings, useSaveTerminalSettings } from "../hooks";
import type { TerminalChoice } from "@muiltchat/shared";
import { Settings, Loader2, Check } from "lucide-react";

const TERMINAL_OPTIONS: { value: TerminalChoice; label: string; hint: string }[] = [
  { value: "wt", label: "Windows Terminal", hint: "wt.exe,未安装时自动回退到系统默认" },
  { value: "cmd", label: "系统默认 (cmd)", hint: "cmd start 新窗口,兼容性最好" },
  { value: "wezterm", label: "WezTerm", hint: "wezterm start,缺失时回退 wt → cmd" },
];

export function SettingsTab() {
  const { data, isLoading, error } = useTerminalSettings();
  const save = useSaveTerminalSettings();

  const [terminal, setTerminal] = useState<TerminalChoice>("wt");
  const [claudePath, setClaudePath] = useState("");
  const [codexPath, setCodexPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

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
      }
    );
  };

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        加载设置...
      </div>
    );

  if (error)
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-5">
        <div>
          <h2 className="text-gray-900 font-semibold text-base flex items-center gap-2">
            <Settings size={16} className="text-gray-500" /> 设置
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            「在终端打开」和运行时 agent 启动使用的终端与可执行文件。
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4 shadow-sm">
          <div>
            <span className="block text-xs font-medium text-gray-700 mb-1.5">
              终端打开方式
            </span>
            <div className="space-y-1.5">
              {TERMINAL_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    terminal === opt.value
                      ? "border-blue-400 bg-blue-50/60"
                      : "border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="terminal"
                    checked={terminal === opt.value}
                    onChange={() => setTerminal(opt.value)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-gray-800">
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-gray-400">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[11px] text-gray-500 mb-1">
                claude 可执行文件
              </span>
              <input
                value={claudePath}
                onChange={(e) => setClaudePath(e.target.value)}
                placeholder="claude"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-gray-500 mb-1">
                codex 可执行文件
              </span>
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
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-50"
            >
              {save.isPending && <Loader2 size={12} className="animate-spin" />}
              保存
            </button>
          </div>
        </div>

        <p className="text-[11px] text-gray-400">
          提示:留空使用默认值(claude / codex,从 PATH 解析)。点击图上任意会话 →
          右侧面板「在终端打开」即可在新终端窗口 resume 该对话。
        </p>
      </div>
    </div>
  );
}

const inputCls =
  "w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 bg-white";
