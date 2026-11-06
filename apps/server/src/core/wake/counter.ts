import { logger } from "../../log.js";

/**
 * Active wake counter for the concurrency limit. Lives in its own module so
 * the launcher can maintain it with a static import — importing wake/index
 * from the launcher is circular, and the previous dynamic import made the
 * increment/exits racy against spawn failures.
 */

let activeWakeCount = 0;

/** Increment active wake counter (called before spawn). */
export function incrementWakeCount(): void {
  activeWakeCount++;
  logger.debug({ activeWakeCount }, "wake process started");
}

/** Decrement active wake counter (called on process exit). */
export function decrementWakeCount(): void {
  activeWakeCount = Math.max(0, activeWakeCount - 1);
  logger.debug({ activeWakeCount }, "wake process ended");
}

/** Get current active wake count (for monitoring/UI). */
export function getActiveWakeCount(): number {
  return activeWakeCount;
}
