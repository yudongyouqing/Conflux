import type { SessionStatus } from "@muiltchat/shared";

const COLORS: Record<SessionStatus, string> = {
  active: "bg-emerald-500",
  stale: "bg-gray-400",
  ended: "bg-red-500",
};

export function StatusDot({ status, busy }: { status: SessionStatus; busy?: boolean }) {
  // busy = a turn is in progress right now (hook event pair for Claude,
  // rollout mtime freshness for Codex) — pulse amber instead of solid green
  const cls =
    status === "active" && busy
      ? "bg-amber-500 animate-pulse"
      : COLORS[status] ?? "bg-gray-400";
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}
