import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeId } from "@conflux/shared";
import { createMcpServer, ensureMcpThread } from "../../mcp/server.js";
import { isValidRuntime, updateThread } from "../../core/threads/store.js";
import { publishLiveEvent } from "../../core/event-bus.js";
import { logger } from "../../log.js";
import type { ServerContext } from "../context.js";

interface ActiveMcpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  peerId: string;
}

function headerStr(req: FastifyRequest, key: string): string | undefined {
  const val = req.headers[key.toLowerCase()];
  if (typeof val !== "string" || !val.trim()) return undefined;
  const trimmed = val.trim();
  try {
    return trimmed.includes("%") ? decodeURIComponent(trimmed) : trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Remote Streamable HTTP MCP endpoint (`/mcp`) with zero-token access by default
 * for trusted LAN / Tailscale setups. Each MCP client session maps 1:1 to a live
 * peer in `agent_threads` and leaves the live graph when the session closes.
 */
export function registerMcpHttpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { db } = ctx;
  const sessions = new Map<string, ActiveMcpHttpSession>();

  const closeSession = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    try {
      if (db.open) {
        const stopped = updateThread(db, entry.peerId, { state: "stopped" });
        if (stopped) {
          publishLiveEvent({
            type: "thread.updated",
            project_id: stopped.project_id,
            thread_id: stopped.id,
            payload: { action: "offline", thread: stopped },
          });
        }
      }
    } catch {
      // ignore shutdown race
    }
  };

  app.addHook("onClose", async () => {
    for (const [sid, entry] of sessions.entries()) {
      sessions.delete(sid);
      try {
        await entry.transport.close();
      } catch {
        // ignore
      }
    }
  });

  const handleMcp = async (req: FastifyRequest, reply: FastifyReply) => {
    const existingSid = headerStr(req, "mcp-session-id");

    if (existingSid) {
      const active = sessions.get(existingSid);
      if (!active) {
        return reply.code(404).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Unknown or expired MCP session" },
          id: null,
        });
      }
      reply.hijack();
      await active.transport.handleRequest(req.raw, reply.raw, req.body);
      if (req.method === "DELETE") {
        closeSession(existingSid);
      }
      return;
    }

    if (req.method !== "POST") {
      return reply.code(400).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "MCP session ID required for GET/DELETE" },
        id: null,
      });
    }

    const rawRuntime = headerStr(req, "x-conflux-runtime")?.toLowerCase();
    const runtime: RuntimeId | undefined = isValidRuntime(rawRuntime) ? rawRuntime : undefined;
    const peerId = ensureMcpThread(db, {
      id: headerStr(req, "x-conflux-session-id") || `mcp-${randomUUID().slice(0, 10)}`,
      external_session_id: headerStr(req, "x-conflux-session-id"),
      host: headerStr(req, "x-conflux-host"),
      project_dir: headerStr(req, "x-conflux-cwd"),
      name: headerStr(req, "x-conflux-name"),
      runtime,
    });

    const server = createMcpServer(db, peerId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, server, peerId });
        logger.info({ sid, peerId }, "remote streamable http mcp peer connected");
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) closeSession(transport.sessionId);
    };

    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", handleMcp);
  app.get("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);
}
