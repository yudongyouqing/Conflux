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
 */

/** The codex-cli minor this executor is certified against (patch wildcard). */
export const SUPPORTED_CODEX_CLI_MINOR = "0.164";

/** Extract the codex version triple from an initialize userAgent. */
export function parseCodexCliVersion(userAgent: string | undefined | null): string | null {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Throws a 400-shaped error when the peer's codex version cannot be
 * determined or is outside the certified minor. Called on both start and
 * resume, before the child drives any thread.
 */
export function assertSupportedCodexVersion(userAgent: string | undefined | null): void {
  const version = parseCodexCliVersion(userAgent);
  if (!version) {
    throw Object.assign(
      new Error(
        `cannot determine codex version from app-server userAgent ${JSON.stringify(userAgent ?? null)} — expected codex-cli ${SUPPORTED_CODEX_CLI_MINOR}.x`,
      ),
      { statusCode: 400 },
    );
  }
  const [major, minor] = version.split(".");
  if (`${major}.${minor}` !== SUPPORTED_CODEX_CLI_MINOR) {
    throw Object.assign(
      new Error(
        `codex-cli ${version} is not supported by the managed executor (certified for ${SUPPORTED_CODEX_CLI_MINOR}.x) — install codex-cli ${SUPPORTED_CODEX_CLI_MINOR}.x or wait for a Conflux update`,
      ),
      { statusCode: 400 },
    );
  }
}
