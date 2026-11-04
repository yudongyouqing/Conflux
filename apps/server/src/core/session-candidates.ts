import type { DB } from "./db.js";
import { listSessions } from "./sessions.js";

const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase().trim();
const pathKey = (value: string) => normalized(value).replace(/\\/g, "/").replace(/\/+$/, "");

/** Suggestions are identity hints, never permission to send or wake a peer. */
export function findSessionCandidates(
  db: DB,
  query: string,
  hints: { project_dir?: string; runtime?: "claude" | "codex" } = {},
) {
  const sessions = listSessions(db, { status: "all" });
  const exact = sessions.find((s) => s.id === query);
  const words = normalized(query).split(/\s+/).filter(Boolean);
  const candidates = sessions
    .map((s) => {
      const reasons: string[] = [];
      let score = 0;
      if (s === exact) {
        score += 1000;
        reasons.push("exact_id");
      }
      if (normalized(s.name) === normalized(query) && query.trim()) {
        score += 100;
        reasons.push("name");
      } else if (words.some((w) => normalized(s.name).includes(w))) {
        score += 40;
        reasons.push("name_fragment");
      }
      if (query && s.id.startsWith(query)) {
        score += 50;
        reasons.push("id_prefix");
      }
      if (
        hints.project_dir &&
        s.project_dir &&
        pathKey(s.project_dir) === pathKey(hints.project_dir)
      ) {
        score += 80;
        reasons.push("project");
      } else if (s.project_dir && words.some((w) => pathKey(s.project_dir!).includes(w))) {
        score += 20;
        reasons.push("project_fragment");
      }
      if (hints.runtime && s.runtime === hints.runtime) {
        score += 20;
        reasons.push("runtime");
      }
      if (s.status === "active") {
        score += 5;
        reasons.push("active");
      }
      if (reasons.length === 0) reasons.push("recent_fallback");
      return {
        id: s.id,
        name: s.name,
        runtime: s.runtime,
        project_dir: s.project_dir,
        status: s.status,
        last_heartbeat_at: s.last_heartbeat_at,
        score,
        reasons,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.last_heartbeat_at.localeCompare(a.last_heartbeat_at) ||
        a.id.localeCompare(b.id),
    );
  return {
    requires_confirmation: !exact,
    match: exact ? "exact_id" : "suggestions",
    candidates: exact ? candidates.filter((s) => s.id === exact.id) : candidates.slice(0, 3),
    next_step: exact
      ? "Use the exact ID only within the user's contact request."
      : "Ask the user to choose a candidate using the host question/options UI (or a numbered list). Include full IDs, project, runtime and activity; allow none/more details. Do not contact or wake a candidate until chosen.",
  };
}
