import { useState } from "react";
import type { Message, SystemNetworkInfo } from "@conflux/shared";
import { Check, Copy, History, Link2, X } from "lucide-react";

type CliTab = "claude" | "codex" | "agy";

interface ConnectRemoteModalProps {
  open: boolean;
  onClose: () => void;
  network?: SystemNetworkInfo;
}

export function ConnectRemoteModal({ open, onClose, network }: ConnectRemoteModalProps) {
  const [cli, setCli] = useState<CliTab>("claude");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!open) return null;

  const hubUrl = network?.hub_url ?? "http://127.0.0.1:9527";
  const mcpUrl = network?.mcp_http_url ?? `${hubUrl}/mcp`;

  const commands: Record<CliTab, { mcp: string; hook: string }> = {
    claude: {
      mcp: `claude mcp add --transport http conflux ${mcpUrl}`,
      hook: `npx conflux hook install claude --hub ${hubUrl}`,
    },
    codex: {
      mcp: `codex mcp add conflux --url ${mcpUrl}`,
      hook: `npx conflux hook install codex --hub ${hubUrl}`,
    },
    agy: {
      mcp: `{ "mcpServers": { "conflux": { "url": "${mcpUrl}" } } }`,
      hook: `npx conflux hook install agy --hub ${hubUrl}`,
    },
  };

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1400);
  };

  return (
    <div
      data-testid="connect-remote-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
    >
      <div className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-overlay">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <Link2 className="h-4 w-4 text-ink-muted" />
              <span>接入本机 / 远程终端 Agent（MCP + 原目录唤醒）</span>
            </h2>
            <p className="mt-0.5 font-mono text-2xs text-ink-faint">
              自动识别内网 / Tailscale 地址：{network?.preferred_ip ?? "127.0.0.1"}:{network?.port ?? 9527} · 零鉴权直连
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-tile-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          <div className="flex gap-1.5">
            {(
              [
                { id: "claude", label: "Claude Code" },
                { id: "codex", label: "Codex CLI" },
                { id: "agy", label: "Antigravity" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setCli(item.id)}
                className={`h-7 rounded-md border px-3 text-xs transition-colors ${
                  cli === item.id
                    ? "border-line-strong bg-tile-active font-semibold text-ink"
                    : "border-line bg-elev text-ink-muted hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1.5 text-2xs font-medium text-ink-muted">
              1. 挂载 Remote Streamable HTTP MCP（4 个黄金工具）
            </div>
            <div className="relative overflow-x-auto rounded-lg border border-line bg-rail p-3 pr-20 font-mono text-2xs text-ink">
              <span>{commands[cli].mcp}</span>
              <button
                type="button"
                onClick={() => copyText("mcp", commands[cli].mcp)}
                className="absolute right-2 top-2 inline-flex h-6 items-center gap-1 rounded border border-line-strong bg-elev px-2 font-sans text-2xs text-ink hover:bg-tile-hover"
              >
                {copiedKey === "mcp" ? (
                  <>
                    <Check className="h-3 w-3 text-success" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>复制</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-2xs font-medium text-ink-muted">
              2. 安装原目录唤醒 Hook（进入原目录按 session_id 续播，绝不起无头线程）
            </div>
            <div className="relative overflow-x-auto rounded-lg border border-line bg-rail p-3 pr-20 font-mono text-2xs text-ink">
              <span>{commands[cli].hook}</span>
              <button
                type="button"
                onClick={() => copyText("hook", commands[cli].hook)}
                className="absolute right-2 top-2 inline-flex h-6 items-center gap-1 rounded border border-line-strong bg-elev px-2 font-sans text-2xs text-ink hover:bg-tile-hover"
              >
                {copiedKey === "hook" ? (
                  <>
                    <Check className="h-3 w-3 text-success" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>复制</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {network && network.addresses.length > 1 && (
            <div className="rounded-lg border border-line bg-elev px-3 py-2 text-2xs text-ink-faint">
              其他可用本机地址：{" "}
              <span className="font-mono text-ink-muted">
                {network.addresses.map((ip) => `http://${ip}:${network.port}/mcp`).join(" · ")}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface CallHistoryModalProps {
  open: boolean;
  onClose: () => void;
  calls: Message[];
}

export function CallHistoryModal({ open, onClose, calls }: CallHistoryModalProps) {
  if (!open) return null;

  return (
    <div
      data-testid="call-history-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
    >
      <div className="flex max-h-[85vh] w-full max-w-[600px] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-overlay">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
            <History className="h-4 w-4 text-ink-muted" />
            <span>历史通话归档（已完成 / 已挂断）</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-tile-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2.5 overflow-y-auto p-4">
          {calls.length === 0 && (
            <div className="py-10 text-center text-xs text-ink-faint">
              暂无历史通话记录。跨 Agent 完成的 MCP 互调将自动归档在这里。
            </div>
          )}

          {calls.map((c) => (
            <div
              key={c.id}
              className="space-y-1.5 rounded-lg border border-line bg-elev p-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-2xs text-ink-faint">
                <span>
                  {c.from_name || c.from_session} → {c.to_name || c.to_session}
                  {c.trace_id ? ` · ${c.trace_id}` : ""}
                </span>
                <span
                  className={
                    c.status === "cancelled"
                      ? "text-danger"
                      : c.status === "replied"
                        ? "text-success"
                        : "text-ink-faint"
                  }
                >
                  {c.status === "cancelled" ? "已挂断" : c.status === "replied" ? "已回复" : c.status}
                </span>
              </div>
              <div className="leading-relaxed text-ink">{c.question}</div>
              {c.reply && (
                <div className="rounded-md border-l-2 border-success bg-surface px-2.5 py-1.5 text-ink-muted">
                  {c.reply}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
