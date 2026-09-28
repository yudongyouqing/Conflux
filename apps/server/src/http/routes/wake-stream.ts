import type { FastifyInstance } from "fastify";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { ServerContext } from "../context.js";

/**
 * SSE endpoint for wake-log streaming (#102): tail the file the wake
 * launcher captures and push new bytes to subscribed browsers. The web
 * channel view renders the woken session's answer growing live —
 * "did the wake actually run" is inspectable for the first time.
 */
export function registerWakeStreamRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { dataDir } = ctx;

  app.get<{ Params: { sessionId: string } }>("/wake/:sessionId/stream", {}, (req, reply) => {
    const logPath = join(dataDir, "wake-logs", `${req.params.sessionId}.log`);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: start\ndata: {"path":${JSON.stringify(logPath)}}\n\n`);

    if (!existsSync(logPath)) {
      reply.raw.write(`event: pending\ndata: {"note":"wake not yet launched"}\n\n`);
    }

    let offset = 0;
    const timer = setInterval(() => {
      try {
        if (!existsSync(logPath)) return;
        const size = statSync(logPath).size;
        if (size <= offset) return;
        const fd = openSync(logPath, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        // SSE data lines must not contain raw newlines — encode as JSON
        const chunk = JSON.stringify(buf.toString("utf8"));
        reply.raw.write(`event: chunk\ndata: ${chunk}\n\n`);
      } catch {
        // file rotated / deleted — next tick will recover
      }
    }, 1000);

    // heartbeat keeps intermediaries from timing out
    const hb = setInterval(() => reply.raw.write(`: hb\n\n`), 15_000);

    req.raw.on("close", () => {
      clearInterval(timer);
      clearInterval(hb);
    });
  });

  // convenience: return the log file content as JSON (for non-SSE consumers)
  app.get<{ Params: { sessionId: string } }>("/wake/:sessionId/log", {}, (req, reply) => {
    const logPath = join(dataDir, "wake-logs", `${req.params.sessionId}.log`);
    if (!existsSync(logPath)) {
      return reply.send({ exists: false, content: null });
    }
    const content = readFileSync(logPath, "utf8");
    return reply.send({ exists: true, content });
  });
}
