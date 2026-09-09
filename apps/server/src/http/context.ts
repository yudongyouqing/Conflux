import type { FastifyReply } from "fastify";
import { publicError, type DB, type PublicErrorCode } from "../core/db.js";
import { heartbeat } from "../core/sessions.js";
import { logAudit } from "../core/audit.js";
import { logger } from "../log.js";

/**
 * Shared per-server context handed to every route module: the DB handle,
 * error mapping with the server's dataDir/port, and the session/audit
 * helpers every route uses. Route modules receive this instead of reaching
 * into closures, so each lives in its own file.
 */

/** The browser UI acts as one fixed pseudo-session. */
export const WEB_CONSOLE_ID = "web-console";

export interface ServerContext {
  db: DB;
  dataDir: string;
  port: number;
  requireSession(req: { headers: Record<string, string | string[] | undefined> }): string;
  audit(sid: string, action: string, args: Record<string, unknown>, result: unknown): void;
  sendError(
    reply: FastifyReply,
    err: unknown,
    sid?: string,
    action?: string,
    args?: Record<string, unknown>,
    statusOverride?: number
  ): FastifyReply;
  sendHttpError(reply: FastifyReply, status: number, message: string): FastifyReply;
}

export function httpError(code: number, message: string): { statusCode: number; message: string } {
  return { statusCode: code, message };
}

export function createServerContext(db: DB, opts: { dataDir: string; port: number }): ServerContext {
  const { dataDir, port } = opts;

  /** Resolve X-Session-Id header (or query) + ensure session exists in DB. */
  function requireSession(req: { headers: Record<string, string | string[] | undefined> }): string {
    const header = req.headers["x-session-id"];
    const sid = Array.isArray(header) ? header[0] : header;
    if (!sid || typeof sid !== "string") {
      throw httpError(400, "missing X-Session-Id header");
    }
    return sid;
  }

  function audit(sid: string, action: string, args: Record<string, unknown>, result: unknown) {
    heartbeat(db, sid);
    logAudit(db, {
      caller_session: sid,
      interface: "http",
      action,
      args,
      result: safeSummary(result),
    });
  }

  /** Send an error reply AND audit the failure (when sid+action are known). */
  function sendError(
    reply: FastifyReply,
    err: unknown,
    sid?: string,
    action?: string,
    args?: Record<string, unknown>,
    statusOverride?: number
  ): FastifyReply {
    const mapped = publicError(err, { dataDir, port });
    const status = statusOverride ?? publicStatus(err, mapped.code);
    logger.error({ err, sid, action, code: mapped.code, status }, "http request failed");
    if (sid && action) {
      try {
        logAudit(db, {
          caller_session: sid,
          interface: "http",
          action,
          args: args ?? {},
          result: { code: mapped.code },
        });
      } catch (auditError) {
        logger.warn({ err: auditError, action }, "failed to audit HTTP error");
      }
    }
    return reply.code(status).send({ ...mapped, error: mapped.message });
  }

  function sendHttpError(reply: FastifyReply, status: number, message: string): FastifyReply {
    const mapped = publicError(httpError(status, message), { dataDir, port });
    return reply.code(status).send({ ...mapped, error: mapped.message });
  }

  return { db, dataDir, port, requireSession, audit, sendError, sendHttpError };
}

export function safeSummary(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v)) return { count: v.length };
    if (typeof v.content === "string") {
      return { id: v.id, contentLen: v.content.length };
    }
    return v;
  }
  return { value: String(value).slice(0, 200) };
}

function publicStatus(error: unknown, code: PublicErrorCode): number {
  if (typeof error === "object" && error !== null) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) {
      return statusCode;
    }
  }
  switch (code) {
    case "DATA_LOCKED":
    case "PORT_IN_USE":
    case "SERVICE_UNAVAILABLE":
      return 503;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "FORBIDDEN":
      return 403;
    case "BAD_REQUEST":
      return 400;
    default:
      return 500;
  }
}
