import type { FastifyReply } from "fastify";
import {
  BUSY_TIMEOUT_MS,
  publicError,
  retryOnBusy,
  type DB,
  type PublicErrorCode,
} from "../core/db.js";
import { logger } from "../log.js";
import { WEB_CONSOLE_ID } from "@conflux/shared";

export { WEB_CONSOLE_ID };

export interface ServerContext {
  db: DB;
  dataDir: string;
  port: number;
  requireSession(req: { headers: Record<string, string | string[] | undefined> }): string;
  sendError(reply: FastifyReply, err: unknown, statusOverride?: number): FastifyReply;
  sendHttpError(reply: FastifyReply, status: number, message: string): FastifyReply;
  write<T>(op: () => T): Promise<T>;
}

export function httpError(code: number, message: string): { statusCode: number; message: string } {
  return { statusCode: code, message };
}

export function resourceId(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw httpError(400, `invalid resource id: ${raw}`);
  }
  return n;
}

export function createServerContext(
  db: DB,
  opts: { dataDir: string; port: number },
): ServerContext {
  const { dataDir, port } = opts;

  function requireSession(req: { headers: Record<string, string | string[] | undefined> }): string {
    const header = req.headers["x-session-id"];
    const sid = Array.isArray(header) ? header[0] : header;
    return sid && typeof sid === "string" && sid.trim() ? sid.trim() : WEB_CONSOLE_ID;
  }

  function sendError(reply: FastifyReply, err: unknown, statusOverride?: number): FastifyReply {
    const mapped = publicError(err, { dataDir, port });
    const status = statusOverride ?? publicStatus(err, mapped.code);
    logger.error({ err, code: mapped.code, status }, "http request failed");
    return reply.code(status).send({ ...mapped, error: mapped.message });
  }

  function sendHttpError(reply: FastifyReply, status: number, message: string): FastifyReply {
    return sendError(reply, httpError(status, message), status);
  }

  function write<T>(op: () => T): Promise<T> {
    return retryOnBusy(db, op, { budgetMs: BUSY_TIMEOUT_MS });
  }

  return { db, dataDir, port, requireSession, sendError, sendHttpError, write };
}

function publicStatus(err: unknown, code: PublicErrorCode): number {
  switch (code) {
    case "DATA_LOCKED":
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
    case "TOO_MANY_REQUESTS":
      return 429;
    default: {
      const raw = (err as { statusCode?: unknown })?.statusCode;
      return typeof raw === "number" && raw >= 400 && raw < 600 ? raw : 500;
    }
  }
}
