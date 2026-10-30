import { RotateCw } from "lucide-react";
import type { Message } from "@conflux/shared";
import { useRetryMessage } from "../hooks";

const DELIVERY_STYLE = {
  queued: "text-warning bg-warning-soft",
  woken: "text-info bg-info-soft",
  failed: "text-danger bg-danger-soft",
};
const DELIVERY_LABEL = { queued: "等待唤醒", woken: "已尝试唤醒", failed: "唤醒失败" };

/** Wake status never implies that the recipient has read the message. */
export function MessageDeliveryControl({ message }: { message: Message }) {
  const retry = useRetryMessage();
  const retriedDelivery = retry.data?.message.delivery;
  const delivery =
    retriedDelivery && retriedDelivery.attempts > (message.delivery?.attempts ?? -1)
      ? retriedDelivery
      : message.delivery;
  if (!delivery && message.status !== "pending") return null;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center flex-wrap gap-2 text-2xs">
        {delivery && (
          <span className={`rounded-md px-1.5 py-0.5 ${DELIVERY_STYLE[delivery.state]}`}>
            {DELIVERY_LABEL[delivery.state]}
          </span>
        )}
        {delivery && <span className="text-ink-faint">尝试 {delivery.attempts} 次</span>}
        {message.status === "pending" && (
          <button
            type="button"
            disabled={retry.isPending}
            onClick={(event) => {
              event.stopPropagation();
              retry.mutate(message.id);
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent border border-accent/30 bg-surface hover:bg-accent-soft disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCw size={12} className={retry.isPending ? "animate-spin" : ""} />
            {retry.isPending ? "正在重试…" : "重试唤醒"}
          </button>
        )}
      </div>
      {delivery?.reason && <p className="text-2xs text-ink-muted break-words">{delivery.reason}</p>}
      {delivery && (
        <p className="text-2xs text-ink-faint">
          最近尝试 {new Date(delivery.last_attempted_at).toLocaleString()}
        </p>
      )}
      {retry.error && (
        <p role="alert" className="text-xs text-danger break-words">
          重试失败：{retry.error.message}
        </p>
      )}
    </div>
  );
}
