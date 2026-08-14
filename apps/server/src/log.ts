import pino from "pino";

/**
 * MCP stdio servers MUST NOT write to stdout (stdout is the protocol channel).
 * Everything goes to stderr through pino. CLI/HTTP modes inherit the same sink
 * by default for consistency, but HTTP/CLI may swap in a different destination.
 */
const dest =
  process.env.MUILTCHAT_LOG_FILE && process.env.MUILTCHAT_LOG_FILE.length > 0
    ? pino.destination(process.env.MUILTCHAT_LOG_FILE)
    : pino.destination(2); // fd 2 = stderr

export const logger = pino(
  {
    name: "muiltchat",
    level: process.env.MUILTCHAT_LOG_LEVEL || "info",
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  dest
);

/** Reconfigure level at runtime (used by CLI flags). */
export function setLogLevel(level: string): void {
  logger.level = level;
}
