import type { SessionStatus } from "@conflux/shared";

const COLORS: Record<SessionStatus, string> = {
  active: "bg-success",
  stale: "bg-neutral",
  ended: "bg-neutral",
};

const LABELS: Record<SessionStatus, string> = {
  active: "在线",
  stale: "离线",
  ended: "已结束",
};

export function sessionStatusAppearance(
  status: string,
  busy?: boolean,
): { className: string; label: string } {
  // Only live turns are busy; an ended session is a normal lifecycle state.
  const isBusy = status === "active" && busy;
  const className = isBusy
    ? "bg-warning animate-pulse"
    : (COLORS[status as SessionStatus] ?? "bg-neutral");
  const label = isBusy ? "忙碌" : (LABELS[status as SessionStatus] ?? "离线");
  return { className, label };
}

export function StatusDot({ status, busy }: { status: SessionStatus; busy?: boolean }) {
  const appearance = sessionStatusAppearance(status, busy);
  return (
    <span
      role="img"
      aria-label={appearance.label}
      title={appearance.label}
      className={`inline-block w-2 h-2 rounded-full ${appearance.className}`}
    />
  );
}
