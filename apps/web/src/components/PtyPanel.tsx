import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, Send } from "lucide-react";

/**
 * PTY output panel (#130): plain-text scroll view of a runtime agent running
 * in a Conflux-owned pseudo-terminal. Not a terminal emulator — just "see
 * what's happening" + a manual inject box. The wake system injects
 * automatically; this lets the human do it too.
 */
export function PtyPanel({ agentId, agentName }: { agentId: number; agentName: string }) {
  const [buffer, setBuffer] = useState("");
  const [alive, setAlive] = useState(false);
  const [injectText, setInjectText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const pty = (globalThis as any).confluxPty as {
  getBuffer(id: number): Promise<{ buffer: string | null }>;
  isAlive(id: number): Promise<boolean>;
  inject(id: number, text: string): Promise<{ ok: boolean }>;
  onOutput(id: number, cb: (chunk: string) => void): () => void;
} | undefined;

  useEffect(() => {
    if (!pty || !agentId) return;
    let unsub: (() => void) | undefined;

    const init = async () => {
      const buf = await pty.getBuffer(agentId);
      setBuffer(buf?.buffer ?? "");
      setAlive(await pty.isAlive(agentId));
      unsub = pty.onOutput(agentId, (chunk: string) => {
        setBuffer((prev) => (prev + chunk).slice(-50_000));
      });
    };
    init();
    return () => unsub?.();
  }, [agentId, pty]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [buffer]);

  const inject = useCallback(async () => {
    const text = injectText.trim();
    if (!text || !pty) return;
    await pty.inject(agentId, text);
    setInjectText("");
  }, [agentId, injectText, pty]);

  if (!pty) {
    return (
      <div className="p-4 text-xs text-ink-faint">
        PTY 面板仅在桌面端可用（浏览器无 IPC 通道）
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-line flex-shrink-0">
        <Terminal size={13} className={alive ? "text-emerald-500" : "text-ink-faint"} />
        <span className="text-xs font-medium text-ink">{agentName}</span>
        <span className="text-2xs text-ink-faint">
          {alive ? "运行中" : "已退出"} · pid #{agentId}
        </span>
      </div>

      {/* output */}
      <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
        <pre className="text-2xs text-ink-muted whitespace-pre-wrap break-all font-mono leading-relaxed">
          {buffer || "(等待输出…)"}
        </pre>
        <div ref={bottomRef} />
      </div>

      {/* manual inject */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-t border-line flex-shrink-0">
        <input
          value={injectText}
          onChange={(e) => setInjectText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && inject()}
          placeholder="手动注入 prompt…"
          className="flex-1 px-2.5 py-1.5 rounded-lg border border-line text-xs text-ink bg-surface placeholder-ink-faint outline-none focus:border-accent"
        />
        <button
          onClick={inject}
          disabled={!injectText.trim() || !alive}
          className="p-1.5 rounded-lg text-ink-faint hover:bg-tile-hover hover:text-ink disabled:opacity-40"
          title="发送到活进程"
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  );
}
