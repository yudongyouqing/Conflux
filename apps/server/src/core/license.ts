/**
 * Commercial feature flag.
 * Set CONFLUX_COMMERCIAL=1 to enable commercial-only features.
 */
export function isCommercial(): boolean {
  return process.env.CONFLUX_COMMERCIAL === "1";
}
