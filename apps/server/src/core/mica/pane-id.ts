/** Mica IDs travel as numbers in JSON and decimal strings in env or headers. */
export function parseMicaPaneId(raw: unknown): number | null {
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
