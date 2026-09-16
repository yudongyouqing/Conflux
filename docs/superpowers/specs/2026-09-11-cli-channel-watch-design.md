# CLI Channel Show and Watch

**Date:** 2026-09-11

**Status:** approved direction, awaiting implementation review

## Problem

Cross-session conversations are persisted as directed graph edges and message
rows in the shared muiltchat SQLite store. The current CLI can inspect a
global message flow, but it cannot present one edge as a conversation or keep
that conversation visible while another runtime is still working.

Claude Code transcripts are a separate, runtime-owned archive. They must not
be used as the channel database and must never be edited by muiltchat.

## Scope

Add a `channel` CLI command group with two commands:

```text
muiltchat channel show <edge-id>
muiltchat channel watch <edge-id> [--interval <milliseconds>]
```

The `conflux` CLI alias exposes the same commands. Existing `msg` commands,
the SQLite schema, and the HTTP edge-history endpoint remain compatible.

This slice does not add unsolicited text injection into a running Claude Code
turn, WebSocket infrastructure, or any write path to Claude transcript files.

## Data Model and Ownership

The shared store remains the source of truth:

```text
<data-dir>/data.db
  edges.rowid             -> channel identity
  messages.edge_id        -> ordered conversation history
  messages.question       -> channel message
  messages.reply/status   -> later update to that message
```

The data directory is resolved through the existing `CONFLUX_HOME`,
`MUILTCHAT_HOME`, project-scope, and `~/.muiltchat` precedence rules. Claude
transcripts under `~/.claude/projects/.../*.jsonl` are read by Claude Code
only and are not part of this feature's storage contract.

## Command Behavior

### `channel show <edge-id>`

- Reads the edge and its messages through the same local-or-HTTP selection as
  other CLI operations.
- Prints one JSON document containing the edge identity and all messages in
  oldest-first order.
- Returns a non-zero exit code with a clear error when the edge does not
  exist.
- Does not mark messages read, update session liveness, or otherwise mutate
  the database.

### `channel watch <edge-id>`

- Prints the same initial JSON document as `channel show`.
- Re-reads the channel at the configurable interval. The default interval is
  1000 ms and the interval must be a positive integer.
- Emits a new JSON document only when a channel snapshot changes.
- A snapshot includes each message's id, status, question, reply, and reply
  timestamp. This catches both new messages and a reply written later onto an
  existing message row.
- Uses polling because SQLite provides no portable cross-process change stream
  for this CLI. With `--http`, it polls the existing HTTP edge endpoint; with
  local mode, it queries SQLite directly.
- Stops cleanly on SIGINT. A removed or unavailable edge ends the command with
  a non-zero exit code rather than silently watching an empty result.

## Runtime Visibility Boundary

`channel watch` is the real-time terminal surface: it remains active and
prints new or updated channel records while Claude, Codex, or another runtime
works. Claude hooks continue to provide a lightweight reminder at supported
hook points (session start and user prompt submission). They cannot safely
inject an arbitrary external message into an already-running model turn.

## Implementation Boundaries

- Extend the CLI layer in `apps/server/src/cli/commands.ts`.
- Reuse `getEdge` and `listEdgeMessages` from `apps/server/src/core/messages.ts`.
- Reuse `GET /edges/:id/messages` for HTTP mode; do not create a second
  persistence representation.
- Extract a small, dependency-injectable channel snapshot/watch helper if that
  keeps the CLI command registration testable.
- Keep formatting machine-readable JSON. One JSON document per emitted
  snapshot is suitable for both interactive terminals and scripts.

## Verification

Tests must demonstrate:

1. `show` returns edge metadata and its oldest-first history.
2. A missing edge fails clearly.
3. The watch snapshot changes when a new message appears.
4. The watch snapshot also changes when an existing message receives a reply.
5. An unchanged poll emits nothing further.
6. Invalid polling intervals are rejected.
7. Existing server tests and TypeScript build still pass.

## Alternatives Rejected

- **Claude JSONL as channel storage:** incomplete across runtimes and unsafe to
  modify.
- **Hooks only:** useful notification timing, but not a continuously visible
  channel.
- **WebSocket first:** useful later for desktop live updates, but unnecessary
  infrastructure for a local CLI watcher.
