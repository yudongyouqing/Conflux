import type { ChatRoom } from "@conflux/shared";

/**
 * Workspace selection state for the chat-first layout: which conversation the
 * main pane is speaking to. Identity is the resource's own id — display names
 * are never part of the key, and the persisted room hint is a UI convenience
 * only, never an authorization fact.
 */
export type ConversationTarget =
  | { kind: "room"; id: number }
  | { kind: "session"; id: string }
  | null;

/** Stable key for draft storage and slow-response bookkeeping. */
export function targetKey(target: Exclude<ConversationTarget, null>): string {
  return target.kind === "room" ? `room:${target.id}` : `session:${target.id}`;
}

export interface WorkspacePreference {
  version: 1;
  /** id + created_at together: a reused numeric id with a fresh creation
   * time is a different room and must not be restored. */
  lastRoom: { id: number; createdAt: string } | null;
  detailsOpen: boolean;
}

export const WORKSPACE_PREFERENCE_KEY = "conflux.workspace.v1";

/** Minimal storage surface so tests can inject failures; JSDOM and browsers
 * satisfy it with the real localStorage. */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isValidPreference(value: unknown): value is WorkspacePreference {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.detailsOpen !== "boolean") return false;
  if (v.lastRoom !== null) {
    if (typeof v.lastRoom !== "object") return false;
    const room = v.lastRoom as Record<string, unknown>;
    if (typeof room.id !== "number" || typeof room.createdAt !== "string") return false;
  }
  return true;
}

/** Read the persisted preference; every storage failure, malformed payload or
 * unknown version degrades to null (callers fall back to defaults). */
export function loadWorkspacePreference(storage: StorageLike = localStorage): WorkspacePreference | null {
  try {
    const raw = storage.getItem(WORKSPACE_PREFERENCE_KEY);
    if (raw === null) return null;
    return isValidPreference(JSON.parse(raw)) ? (JSON.parse(raw) as WorkspacePreference) : null;
  } catch {
    return null;
  }
}

/** Persist the preference; a full/disabled storage never breaks the current
 * interaction — the write is simply dropped. */
export function saveWorkspacePreference(
  preference: WorkspacePreference,
  storage: StorageLike = localStorage,
): void {
  try {
    storage.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    /* quota exceeded / private mode — keep going without persistence */
  }
}

/**
 * Resolve the room to select after the room list loads. A remembered room is
 * honored only when BOTH the numeric id and its creation time match; anything
 * else falls back to the most recently updated room (ties: higher id first)
 * so a stale hint can never point at a reincarnated room. Call this only with
 * a successfully fetched list — an error response is not "no rooms".
 */
export function restoreRoom(
  rooms: readonly ChatRoom[],
  remembered: WorkspacePreference["lastRoom"],
): ChatRoom | null {
  if (rooms.length === 0) return null;
  if (remembered) {
    const match = rooms.find(
      (r) => r.id === remembered.id && r.created_at === remembered.createdAt,
    );
    if (match) return match;
  }
  const sorted = [...rooms].sort((a, b) => {
    const byUpdated = b.updated_at.localeCompare(a.updated_at);
    return byUpdated !== 0 ? byUpdated : b.id - a.id;
  });
  return sorted[0] ?? null;
}

// ---- per-target composer drafts ------------------------------------------

export interface Draft {
  text: string;
  revision: number;
}

/** Drafts keyed by targetKey — switching rooms or conversations preserves
 * every target's own unsent text; nothing survives an app restart. */
export type DraftMap = Record<string, Draft>;

export type DraftsAction =
  | { type: "edit"; targetKey: string; text: string }
  | { type: "submitted"; targetKey: string; revision: number };

export function draftsReducer(state: DraftMap, action: DraftsAction): DraftMap {
  switch (action.type) {
    case "edit": {
      const current = state[action.targetKey] ?? { text: "", revision: 0 };
      return {
        ...state,
        [action.targetKey]: { text: action.text, revision: current.revision + 1 },
      };
    }
    case "submitted": {
      const current = state[action.targetKey];
      // Clear only the exact snapshot that was sent: if typing continued
      // while the request was in flight the revision moved on and the newer
      // text survives.
      if (!current || current.revision !== action.revision) return state;
      if (current.text === "") return state;
      return { ...state, [action.targetKey]: { text: "", revision: current.revision } };
    }
  }
}
