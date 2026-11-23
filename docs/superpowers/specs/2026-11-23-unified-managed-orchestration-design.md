# Conflux Unified Managed Orchestration Design

Date: 2026-11-23

## Goal

Unify native provider takeover (Claude Code, Codex, Antigravity `agy acp`, and generic ACP CLIs) with Conflux's multi-agent collaboration layer (session graph, chat rooms, DAG workflows, persistent structured memory, and cross-provider context handoff) while keeping external terminal sessions (Hooks/MCP) as first-class peers on the same graph.

## Architecture Layers

1. **Native Provider Takeover (`apps/server/src/core/managed*`)**
   - `RuntimeAdapter` (`core/managed/adapter.ts`) defines a runtime-agnostic contract: `initialize`, `startThread`, `resumeThread`, `startTurn`, optional `steerTurn`, `interrupt`, `formatApprovalResponse`, `classifyServerRequest`, and `normalizeNotification`.
   - Concrete runtimes:
     - `managed-codex`: `codex app-server` JSON-RPC 2.0, `turn/steer`, `userInput` approvals, and automatic Conflux MCP injection (`buildCodexManagedMcpArgs`).
     - `managed-claude`: bidirectional NDJSON `stream-json` + control protocol, `priority: "next"` active-turn steering, `AskUserQuestion` -> `userInput` approval responses, and automatic `--mcp-config` injection (`ensureWakeMcpConfig`).
     - `managed-acp`: JSON-RPC 2.0 ACP client (`initialize`, `session/new`, `session/load`, non-blocking `session/prompt` -> synthetic `acp/turn_completed`, `session/cancel`, `session/request_permission` with verbatim `optionId` round-trip). Specializes `antigravity` (`agy acp`) with `fs.writeTextFile = false`, `_meta.antigravity.systemPrompt.append`, `agy >= 1.5.0` prompt steering, and automatic `mcpServers` injection.
2. **Managed × Room Fusion & Unified Live Events**
   - `core/ask.ts` and `core/room-orchestrator.ts` support `delivery_mode: "queue" | "steer" | "interrupt"`.
   - `completeSummon` and `notifyInitiator` route managed targets directly to `ManagedExecutor`, falling back to `tmuxInject` / `headlessWake` for external terminal sessions.
   - `installManagedOrchestrationHooks()` bridges `onManagedTurnFinalized` into automatic `room_tasks` completion fallback and DAG workflow step advancement.
   - `core/event-bus.ts` + `GET /live/events` SSE provides a bounded ring buffer (`Last-Event-ID` replay) fanning out `managed.event`, `room.message`, `room.task`, `workflow.updated`, and `context.updated`.
3. **DAG Workflows & Structured Memory / Handoff (SQLite Schema v17)**
   - `core/workflows.ts` persists `workflows`, `workflow_runs`, and `workflow_steps`; validates acyclicity with Kahn's algorithm; schedules root and unblocked downstream steps; pauses at `human_gate` steps for console approval; and advances automatically on both managed turn completions and external `reply_ask`.
   - `core/context.ts` + `core/search.ts` add `room_id`, `kind` (`note | decision | artifact | handoff`), and `pinned` while preserving FTS5 search and backward compatibility.
   - `core/handoff.ts` builds bounded handoff dossiers from pinned/decision/artifact memory, upstream workflow outputs, and recent replies, stores a `kind = 'handoff'` entry, and delivers it to any target session.
4. **Multi-Surface Workspace UI (`apps/web`)**
   - `useLiveEvents` subscribes to `/live/events` for targeted React Query invalidations.
   - `ManagedSessionPanel` (`ManagedCodexPanel.tsx`) supports standalone and compact embedded modes, native ACP `optionId` buttons, `userInput` answer cards, and active-turn Steer.
   - `DetailPanel` embeds `ManagedSessionPanel` and one-click cross-session Handoff directly when inspecting nodes on the graph or in rooms.
   - `WorkspaceTab` adds a `工作流` (`WorkflowView`) surface beside `聊天` and `图谱`, providing DAG creation, live step progress, inline `human_gate` approval, and room shared memory management.
