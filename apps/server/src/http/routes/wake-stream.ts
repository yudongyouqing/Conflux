import { StringDecoder } from "node:string_decoder";
import type { FastifyInstance } from "fastify";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { ServerContext } from "../context.js";

/**
 * SSE endpoint for wake-log streaming: tail the file the wake
 * launcher captures and push new bytes to subscribed browsers. The web
 * channel view renders the woken session's answer growing live —
 * "did the wake actually run" is inspectable for the first time.
 */
export function registerWakeStreamRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { dataDir } = ctx;
  const options = { schema: { params: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 200 } } } } };

  app.get<{ Params: { sessionId: string } }>("/wake/:sessionId/stream", options, (req, reply) => {
    const logPath = join(dataDir, "wake-logs", `${req.params.sessionId}.log`);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: start\ndata: {}\n\n`);

    if (!existsSync(logPath)) {
      reply.raw.write(`event: pending\ndata: {"note":"wake not yet launched"}\n\n`);
    }

    let offset = 0;
    let decoder = new StringDecoder("utf8");
    const timer = setInterval(() => {
      try {
        if (!existsSync(logPath)) return;
        const size = statSync(logPath).size;
        if (size < offset) { offset = 0; decoder = new StringDecoder("utf8"); }
        if (size === offset) return;
        const fd = openSync(logPath, "r");
        const buf = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        let count: number;
        try { count = readSync(fd, buf, 0, buf.length, offset); }
        finally { closeSync(fd); }
        offset += count;
        // SSE data lines must not contain raw newlines — encode as JSON
        const chunk = JSON.stringify(decoder.write(buf.subarray(0, count)));
        reply.raw.write(`event: chunk\ndata: ${chunk}\n\n`);
        if (/\[wake ended [^\]]+\]\s*$/.test(buf.subarray(0, count).toString("utf8"))) {
          reply.raw.write(`event: ended\ndata: {}\n\n`);
        }
      } catch {
        // file rotated / deleted — next tick will recover
      }
    }, 1000);

    // heartbeat keeps intermediaries from timing out
    const hb = setInterval(() => reply.raw.write(`: hb\n\n`), 15_000);

    reply.raw.on("close", () => {
      clearInterval(timer);
      clearInterval(hb);
    });
  });

  // convenience: return the log file content as JSON (for non-SSE consumers)
  app.get<{ Params: { sessionId: string } }>("/wake/:sessionId/log", options, (req, reply) => {
    const logPath = join(dataDir, "wake-logs", `${req.params.sessionId}.log`);
    if (!existsSync(logPath)) {
      return reply.send({ exists: false, content: null });
    }
    const content = readFileSync(logPath, "utf8");
    return reply.send({ exists: true, content });
  });
}
