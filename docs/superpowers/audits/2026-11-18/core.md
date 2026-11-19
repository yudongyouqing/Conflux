# CORE audit disposition

Scope: recovered `agy-handoff/step-54.txt`, first report copy only; compared with current source and uncommitted diff in `.worktrees/fix/339-audit-defects` (base `94a976b`). This is a per-finding reconciliation, not a new whole-repository audit. `fixed` means the reported mechanism is addressed in source; validation results belong to the root agent's run. Integrated tests/build are tracked by the root agent; this document does not duplicate or override that validation record. `partial` explicitly retains unresolved portions. `deferred` means current source still contains the report's mechanism or the requested cleanup/decision has no corresponding diff. No finding is declared false-positive without contrary evidence.

## Broken

| ID | Disposition | Current evidence / remaining decision |
|---|---|---|
| B1 | fixed | `core/wake/launcher.ts:launchWakeRun` computes `captureStdout` from resolved `dataDir` and persistent `db.name`; calls `pipeWakeLog(child, dataDir, sessionId)`. In-memory handles do not implicitly enable capture. |
| B2 | fixed | `managed-codex/approvals.ts:recordApproval` fetches by `result.lastInsertRowid`; `managed/executor.ts:resolveApproval` verifies approval run belongs to requested instance before returning state conflict. |
| B3 | fixed (reported priority-only case) | `core/sessions.ts:registerSession` uses `json_set(existing metadata, '$.priority', ?)` for `input.priority && !input.metadata`. Explicit supplied metadata retains existing replacement semantics; this does not claim general metadata merging. |
| B4 | fixed | `core/messages.ts:gatherUnseenMail` selects `m.edge_id`; truncation hints and both mail renderers use `edge_id`, falling back to `check_inbox` / `check_replies` for legacy null edges. |
| B5 | partial | `data-transfer.ts` runtime export SELECT now includes `execution_mode`. Bundle coverage of rooms/tasks and preservation of `chat_room_id`/`room_id`, plus replacing sessions/messages `SELECT *`, remain unchanged and need user review. |
| B6 | fixed | `room-orchestrator.ts:injectIntoProcess` and `notifyInitiator` pass stamped `meta.tmux_session`; `wake/tmux-inject.ts:tmuxInject` accepts optional target and otherwise retains legacy fallback. |
| B7 | fixed | `managed/executor.ts:resumeInstance` migrates `managed_codex_events.instance_id`, merges `runtime_instance_id` and managed thread metadata, and heartbeats reused session within migration path. |
| B8 | fixed | `managed/executor.ts` calls `maybePushReply` after successful `finalizeRunAndReply` in normal completion and historical completed/failed/interrupted reconciliation paths. |
| B9 | fixed in source | `wake/launcher.ts:pinCodexDescendants` has non-Windows `/bin/ps` descendant walk and shared `persist` guarded by `db.open`, `retryOnBusy`, transaction and caught/logged rejection. Real macOS/Linux adoption remains a runtime validation item, not proven here. |
| B10 | fixed | `runtime-agents.ts:runScheduledAgent` exit/error listeners call `writeCompletion`, which checks DB openness inside `retryOnBusy` and catches/logs errors rather than throwing through EventEmitter. |
| B11 | partial | `live.ts` session-name/transcript lookup honor `CLAUDE_CONFIG_DIR`; Windows helper now uses `CONFLUX_HOME` / `.conflux` and rewrites stale script content. `codex-titles.ts` and `codex-rollout.ts:findCodexRolloutPath` now honor `CODEX_HOME`. Embedded Windows quoted-path matcher remains unchanged; registry Codex `sessionHome` still hardcodes `.codex`. Those remaining subparts prevent calling all B11 fixed. |
| B12 | fixed | `messages.ts:recordExchange` uses an immediate transaction, rejects self exchange, records one channel and inserts its `edge_id`; no reply-created reverse `recordEdge`. |
| B13 | fixed | `messages.ts:askSession` wraps source check, edge mutation and message insert in immediate transaction; missing source gets explicit 404. |
| B14 | fixed | `data-clear.ts:applyDeletes` clears edges with messages and removes orphan managed bindings, room tasks, Claude/Codex current markers and auto-wake settings after session clearing. |
| B15 | deferred | `agent-runner.ts:107` still records edge to literal `web-ui`; `:163` still calls raw `askSession`. No change in this file. Requires routing internal asks through normal delivery/wake boundary and selecting valid human identity. |
| B16 | fixed | `managed-codex/adapter.ts:defaultCodexLaunch` sets `CONFLUX_HOME = dirname(db.name)` only for nonempty persistent DB name. |
| B17 | fixed in source | `ask.ts:completeAsk` retries managed enqueue; lock exhaustion returns accepted/queued result, and post-enqueue delivery-status lock exhaustion is caught/logged. Non-lock failures still propagate. |
| B18.1 | fixed | Provider test now passes `{ apiKey: api_key, baseURL: base_url }`; provider factories use `createAnthropic` / `createOpenAI` with supplied options. |
| B18.2 | fixed | `http/routes/settings.ts` enum now includes terminal/iterm/tmux. |
| B18.3 | fixed in source | `terminal.ts:resumeCommand` selects cmd or POSIX quoting by platform; PowerShell launch adds call operator for initial quoted executable. Existing terminal regression tests changed; no OS execution in this reconciliation. |
| B18.4 | partial | Runtime request interface/schema now accepts `execution_mode` (and nullable interval). Runtime catalog and POST still allow all `RUNTIME_IDS`, but `createRuntimeAgent` still accepts only claude/codex. Choose filtering or expanded support. |
| B18.5 | fixed | `web/src/api.ts:checkInbox` now returns `{ inbox: Message[] }`. |
| B18.6 | deferred | `web/src/api.ts` summon still declares `{ task_id }`; server returns task object from summon/orchestrate. Task-token exposure policy and response contract remain unresolved. |
| B18.7 | deferred | `http/server.ts:198` still registers CORS `{ origin: true }`; runtime liveness rows still carry preset credentials. No CORS/credential redesign in diff. Browser local-network controls vary; source-level permissive configuration is confirmed, universal exploitability is not asserted. |
| B18.8 | fixed | Both wake routes share params schema `^[A-Za-z0-9_-]+$`, max 200; prevents separators and dot traversal before joining log path. |
| B18.9 | fixed in inspected command paths | CLI local operations changed to `withDb`; helper stops WAL checkpoint then closes in `finally`; channel watchers and sessions-end explicit finally also stop checkpoint. Hook/backfill use resolved CLI data-dir. This is source lifecycle evidence, not a claim every CLI subprocess was exercised. |
| B18.10 | fixed | `apps/server/package.json` files list removes nonexistent README/.mcp entries. |

## Inconsistent

| ID | Disposition | Current evidence / remaining decision |
|---|---|---|
| I1.1 | fixed | Shared `Session` has optional nullable `chat_room_id`. |
| I1.2 | fixed | `messages.ts:MessageRow` has nullable `room_id`. |
| I1.3 | fixed | `chat-rooms.ts` imports/re-exports shared `ChatRoom`; managed types import/re-export shared `ManagedRunState`. |
| I1.4 | fixed | `ManagedCodexEvent.runId` is `number | null`. |
| I1.5 | fixed | Managed status route normalizes missing binding to null; shared/executor active state uses `ManagedRunState`; payload is `Record<string, unknown>`. |
| I1.6 | fixed | Shared exports Codex auto-description and includes it in placeholder list; codex-titles imports common constant. |
| I1.7 | partial | Fresh schema now includes session/message/runtime-agent columns previously added only by migration. Stranded graph-edge comment remains above `room_tasks`, still claiming reply-created edge weight. |
| I2 | partial | Managed route error bodies now use `sendHttpError`; chat-room routes use shared errors and request validation. Domain throws for `ASK_PRIORITY_BLOCKED`, `invalid task token`, `room name required`, runtime/name/env/interval/workdir and app-settings terminal remain plain Error, with unchanged `publicError` mapping. Invalid HTTP resource IDs and data-bundle parser validation now carry explicit 400 while lock errors remain 503; broad domain error classification is not fixed. |
| I3 | fixed | New `server/src/version.ts:APP_VERSION` reads package metadata; CLI version, OpenAPI and MCP metadata use it. |
| I4 | partial | Many core/shared references removed. CLI still has `issue #75` and `issue #83`; MCP and HTTP room route issue references were not comprehensively removed. No claim all 46 references are gone. |
| I5 | partial | Session route uses `randomUUID` and normalized runtime with legacy metadata fallback. Managed status route still executes raw SQL; runtime-agnostic executor still imports Codex implementation modules. Module boundary redesign and core query extraction deferred. |
| I6 | deferred | `core/graph.ts` unchanged: internal agent nodes and all edges remain outside session status filter. Need product decision on filtered graph semantics. |

## Inefficient

| ID | Disposition | Current evidence / remaining decision |
|---|---|---|
| E1 | fixed for zero active rows | `codex-titles.ts:refreshCodexSessionTitles` now returns before rollout/index I/O when queried rows length is zero. No broader active-session scan optimization claimed. |
| E2 | fixed for no expired rows | `sessions.ts:markStaleSessions` first probes SELECT 1 LIMIT 1 and returns zero without UPDATE when none expire. Expiring sessions can still require write lock; this is expected, not eliminated. |
| E3 | fixed for duplicate misses | `terminal.ts:resolveOnPath` returns null after normal nonzero resolver exit, retrying exceptional timeout/failure only. Also fixes Linux resolver selection. No availability cache added; optional cache remains a performance follow-up. |
| E4.1 | fixed | `listChatRooms` batches all member IDs into one query and Map; migration adds sessions(chat_room_id) index. |
| E4.2 | fixed | migration adds messages(edge_id,id). |
| E4.3 | fixed | migration adds messages(room_id,id). |
| E4.4 | fixed | migration adds messages(from_session,to_session,id). |
| E4.5 | fixed | migration adds room_tasks(room_id,initiator_session_id,status). |
| E4.6 | fixed | migration adds managed_codex_bindings(session_id). |
| E4.7 | fixed | migration adds managed_codex_approvals(run_id,state). Schema version is 16. |
| E5 | partial | `children` now retains only `{ exited }`, avoiding full process/RPC/buffer object retention, and deletes migrated predecessor on resume. Distinct completed IDs still stay in Map; other delete is test-only forget. Full bounded retention is not established. |
| E6 | deferred | `runtime-instances.ts` unchanged: per-row lookups and synchronous Windows process inspection remain. N+1 SQL batching is a concrete remaining fix; asynchronous process probing requires design review. |
| E7 | fixed | `conversations.ts:addTurn` selects inserted turn by lastInsertRowid rather than loading all turns. |

## No longer needed

| ID | Disposition | Current evidence / remaining decision |
|---|---|---|
| N1 | deferred | Shared `TopologyStep`, `ChatRoomRow.topology`, and createChatRoom dummy topology write remain. Removing public type/schema payload requires compatibility decision. |
| N2 | deferred | `findSessionByClaudePid` and Claude-only liveness wrappers remain; no liveness file diff. Test import compatibility must be checked before removal. |
| N3.1 | deferred | `tmuxSessionAlive` still exported. |
| N3.2 | deferred | `wake/codex.ts` AUTO_WAKE_PROMPT re-export unchanged. |
| N3.3 | deferred | `runtime-agents.ts` cleanTerminalEnv re-export remains. |
| N3.4 | deferred | `runtime-instances.ts:getRuntimeInstance` remains. |
| N3.5 | deferred | `room-orchestrator.ts:broadcastToRoom` remains. |
| N3.6 | deferred | `managed-codex/store.ts:replaceManagedBindingOwner` unchanged. |
| N3.7 | deferred | `approvals.ts:getApprovalByRpcId` remains after recordApproval stopped using it. |
| N3.8 | deferred | managed events `isTerminalNotification` / `finalTextFromItem` unchanged. |
| N3.9 | deferred | terminal-state constant and ManagedCodexBinding type remain. |
| N3.10 | deferred | manager defaultLaunch wrapper unchanged. |
| N3.11 | deferred | process appServerArgv / shimLogPath exports unchanged. |
| N3.12 | deferred | Executor isManagedSession / bindingForSession / enqueue and test-only crash/forget/adopt state remain. Removing test hooks is a test architecture change, not required to validate runtime fixes. |
| N3.13 | deferred | HTTP monolith compatibility getContext/getMessage/getSession re-exports remain. |
| N3.14 | deferred | Server tsconfig still has allowSyntheticDefaultImports true and noUnusedLocals/noUnusedParameters false. Current tsconfig diff only formats/excludes tests; it does not implement dead-code checking. |

Review priority: unresolved B11/B15 and I2 are behavioral defects; B18.7 and B18.6 need explicit local API credential/token decisions; B5 room data preservation needs bundle format decisions. Performance and cleanup items must not be represented as completed fixes.
