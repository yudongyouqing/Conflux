import type { SessionStatus } from "../types";

const COLORS: Record<SessionStatus, string> = {
  active: "bg-green-500",
  stale: "bg-gray-400",
  ended: "bg-red-500",
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${COLORS[status] ?? "bg-gray-500"}`}
    />
  );
}
