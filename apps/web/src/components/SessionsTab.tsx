import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { StatusDot } from "./StatusDot";
import { InlineMarkdown } from "./InlineMarkdown";
import { Search, Inbox } from "lucide-react";
import { PLACEHOLDER_DESCRIPTIONS, type SessionSummary } from "@conflux/shared";

interface SessionsTabProps {
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
}

function relative(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h 前`;
  return `${Math.floor(sec / 86400)}d 前`;
}

/** Sidebar-style flat session list, AgentRecall-inspired:
 * project grouping, recency ordering, live badges, search. */
export function SessionsTab({ onSelectSession, selectedSessionId }: SessionsTabProps) {
  const [q, setQ] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["sessions-list"],
    queryFn: () => api.getSessions("all"),
    refetchInterval: 5000,
  });

  const groups = useMemo(() => {
    const sessions = (data?.sessions ?? []).filter((s) => {
      if (!q.trim()) return true;
      const needle = q.trim().toLowerCase();
      return (
        s.name.toLowerCase().includes(needle) ||
        (s.description ?? "").toLowerCase().includes(needle) ||
        (s.project_dir ?? "").toLowerCase().includes(needle)
      );
    });
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const key = s.project_dir ?? "(未知项目)";
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }
    // freshest project first; freshest session first within a project
    return [...byProject.entries()]
      .map(([dir, list]) => ({
        dir,
        list: list.sort((a, b) => b.last_heartbeat_at.localeCompare(a.last_heartbeat_at)),
        latest: list.reduce((m, s) => (s.last_heartbeat_at > m ? s.last_heartbeat_at : m), ""),
      }))
      .sort((a, b) => b.latest.localeCompare(a.latest));
  }, [data, q]);

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">加载会话…</div>
    );
  if (error)
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm">
        连接失败: {(error as Error).message}
      </div>
    );

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="sticky top-0 bg-white border-b border-line p-3 z-10">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称 / 正在做什么 / 项目路径…"
            className="w-full text-xs pl-7 pr-2 py-1.5 rounded-lg border border-line bg-white focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent"
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="p-6 text-center text-xs text-ink-faint">没有匹配的会话</div>
      ) : (
        <div className="p-3 space-y-4">
          {groups.map((g) => (
            <div key={g.dir}>
              <div
                className="font-mono text-[11px] text-ink-muted truncate mb-1.5 px-1"
                title={g.dir}
              >
                {g.dir}
              </div>
              <div className="space-y-1">
                {g.list.map((s: SessionSummary) => {
                  const selected = s.id === selectedSessionId;
                  return (
                    <button
                      key={s.id}
                      onClick={() => onSelectSession(s.id)}
                      className={`w-full text-left px-3 py-2 rounded-xl border transition-colors ${
                        selected
                          ? "bg-white border-accent/50 ring-2 ring-accent/25"
                          : "bg-white border-line hover:border-line-strong hover:shadow-card"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot status={s.status} busy={s.busy} />
                        <span className="text-xs font-medium text-ink truncate flex-1">
                          {s.name}
                        </span>
                        <span className="text-[10px] text-ink-faint flex-shrink-0">
                          {relative(s.last_heartbeat_at)}
                        </span>
                      </div>
                      {s.description &&
                        !(PLACEHOLDER_DESCRIPTIONS as readonly string[]).includes(
                          s.description,
                        ) && (
                          <div
                            className="text-[11px] text-ink-muted truncate mt-0.5"
                            title={s.description}
                          >
                            <InlineMarkdown>{s.description}</InlineMarkdown>
                          </div>
                        )}
                      {s.pending_inbox > 0 && (
                        <div className="flex items-center gap-1 text-[10px] text-amber-600 mt-0.5">
                          <Inbox size={10} /> {s.pending_inbox} 待回复
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
