/**
 * Codex app-server compatibility gate. The managed executor speaks the
 * stdio protocol of ONE certified codex-cli minor (the wire shape of
 * thread/start, thread/resume and the item/turn notifications is not
 * semver-stable across codex releases), so the initialize handshake's
 * userAgent is checked against it before any thread is created.
 *
 * The real app-server reports `<originator>/<version> (<os> <ver>; <arch>)…`
 * (e.g. `codex_cli_rs/0.164.0 (Windows 11; x86_64) …`), so the FIRST
 * major.minor.patch triple in the string is the codex version; later numbers
 * belong to the OS description and never come first.
 *
 * Escape hatch for users whose codex auto-updated past the certified minor:
 * `CONFLUX_MANAGED_CODEX_ALLOW_MINOR` overrides the check — set it to the
 * minor to accept (`0.165`) or to `any` to disable the gate entirely, at
 * your own protocol-drift risk.
 */

import { logger } from "../../log.js";

/** The codex-cli minor this executor is certified against (patch wildcard). */
export const SUPPORTED_CODEX_CLI_MINOR = "0.164";

/** Env var overriding the certified minor ("any" disables the gate). */
export const ALLOW_MINOR_ENV = "CONFLUX_MANAGED_CODEX_ALLOW_MINOR";

/** Resolve the effective gate: an override minor, "any", or null (= certified). */
function effectiveGate() {
  const raw = process.env[ALLOW_MINOR_ENV]?.trim();
  if (!raw) return { mode: "minor" as const, minor: SUPPORTED_CODEX_CLI_MINOR };
  if (raw.toLowerCase() === "any") return { mode: "any" as const, minor: null };
  if (/^\d+\.\d+$/.test(raw)) return { mode: "minor" as const, minor: raw };
  // An invalid override must not silently weaken the gate — warn and fall
  // back to the certified minor so the failure mode stays loud.
  logger.warn(
    { env: ALLOW_MINOR_ENV, value: raw },
    `invalid ${ALLOW_MINOR_ENV} (expected "<major>.<minor>" or "any") — using certified ${SUPPORTED_CODEX_CLI_MINOR}`,
  );
  return { mode: "minor" as const, minor: SUPPORTED_CODEX_CLI_MINOR };
}

/** Extract the codex version triple from an initialize userAgent. */
export function parseCodexCliVersion(userAgent: string | undefined | null): string | null {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Throws a 400-shaped error when the peer's codex version cannot be
 * determined or is outside the accepted minor. Called on both start and
 * resume, before the child drives any thread. Honors the escape hatch env.
 */
export function assertSupportedCodexVersion(userAgent: string | undefined | null): void {
  const gate = effectiveGate();
  const version = parseCodexCliVersion(userAgent);
  if (!version) {
    throw Object.assign(
      new Error(
        `cannot determine codex version from app-server userAgent ${JSON.stringify(userAgent ?? null)} — expected codex-cli ${gate.minor ?? SUPPORTED_CODEX_CLI_MINOR}.x`,
      ),
      { statusCode: 400 },
    );
  }
  if (gate.mode === "any") return;
  const [major, minor] = version.split(".");
  if (`${major}.${minor}` !== gate.minor) {
    throw Object.assign(
      new Error(
        `codex-cli ${version} is not supported by the managed executor (certified for ${SUPPORTED_CODEX_CLI_MINOR}.x) — install codex-cli ${gate.minor}.x, wait for a Conflux update, or set ${ALLOW_MINOR_ENV}=${gate.minor} to override at your own risk`,
      ),
      { statusCode: 400 },
    );
  }
}
