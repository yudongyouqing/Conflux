# Repository audit — 2026-11-18

Continues the whole-repository audit tracked in [issue 339](https://github.com/yudongyouqing/Conflux/issues/339). Audit baseline: `94a976b`.

The earlier session produced candidate reports and stopped before implementing fixes. The tables below distinguish changes supported by code/contracts/regressions from candidates still requiring owner review. This is not a claim that every historical finding was correct or every possible defect has been removed.

## Delivered changes

- Core: preserve metadata on priority updates; atomic question/channel writes and channel references; approval ownership; managed export mode; cleanup of deleted session state; correct tmux target identity; managed resume event/session continuity and reply notifications; bounded retry for asynchronous database callbacks; configured runtime homes; fewer unnecessary scans/queries and schema 16 lookup indexes.
- Adapters: normalized managed event JSON/SSE; macOS terminal choices; provider test request credentials; native external conversation IDs and refusal to bypass managed ownership; wake log path validation/stream cleanup; bodyless remote CLI requests; portable project export selection; hook data-directory and symlink handling; one-shot SQLite handle/timer cleanup; real errors for unsupported remote session end; package-derived version; request validation and public summon response; preserve database error statuses while bundle validation stays HTTP 400.
- Web: cancellable context/chat requests; transport/IME recovery; import invalidation; hidden-settings polling; managed event cursors and initial-status refresh race; current selected graph data and viewport lifecycle; unsafe inline links; bounded/reconnect-aware wake text.
- Desktop/repository: readiness deadlines, lifecycle/notification cleanup and stalled-request cancellation, trusted IPC checks, production CSP header, platform tray assets, close opt-in, safer main gate, secret scanner coverage, packaging exclusions, screenshot scripts/current screenshots, CI coverage and focused documentation corrections.

## Detailed disposition

- [Core and shared contracts](core.md): every recovered finding/subfinding, including partially fixed candidates.
- [Web](web.md): behavioral fixes and deferred layout/product/performance candidates.
- [Desktop, scripts, CI and documentation](desktop.md).
- [Adapters](adapters.md).

Additional review repairs: restore a declaration accidentally swallowed during comment cleanup; prevent a managed thread from being opened by an untracked second terminal writer; keep validation errors as 400 after removing the blanket import status override; cancel stalled desktop notification response bodies. Test maintenance also removes retained React Query mutation GC timers from the assistants suite.

## Owner review required

1. **PTY and compatibility:** wire or remove the unused desktop PTY bridge; decide whether to retain `muiltchatDesktop`, legacy wrapper exports, old scripts and third-party skills. Nothing was deleted solely because no internal caller was found.
2. **Data format:** bundle v1 still omits room/task/settings/managed history. A backup can restore its documented v1 entities, but it is not a full snapshot of every newer table. A versioned format/migration needs design and acceptance.
3. **Internal agent runner:** its `web-ui` edge identity and direct ask path remain to be reconciled with current wake/managed orchestration. Changing this path needs model-run acceptance.
4. **Performance/lifecycle:** runtime process inspection/batching, remaining executor witness-map growth, read-side heartbeat/audit locks, large wake logs, graph rendering/layout and CSS candidates remain in the detailed tables. Added indexes do not establish a measured speedup.
5. **Notifications/live status:** notifications still poll the newest 500 rows; older replies can fall outside that window. Wake output still infers completion from text markers; abrupt termination and markers split across chunks need a proper run-state protocol.
6. **Policy/retention/release:** reconcile paired AGENTS/CLAUDE wording, minimum Node version, token-floor/mono exceptions, package/profile naming, historical plan statuses and benchmark/artifact retention. Local prototype/worktree directories were preserved.

## Validation

Validation uses an independent `npm ci --ignore-scripts` install in this worktree, the bundled SQLite prebuild, and this worktree's own shared package output. Regression fixtures use isolated databases; no live-model host acceptance is claimed. Browser fixtures explicitly override CLI paths to prevent real model launches.

| Check | Result |
|---|---|
| `npm test -w apps/server` | 429 passed, using the isolated install |
| `npm test -w apps/web` | 150 passed; query/mutation test-cache teardown corrected |
| `npm run test:desktop` | 80 passed |
| Release, packaged-module, scanner and chat-first harness unit tests | 20 passed |
| `npm run test:process-e2e -w apps/server` | 49 passed, 2 platform skips |
| `npm run build` | Passed; existing Vite deprecation/chunk warnings remain |
| `npm run lint`, `npm run check:tokens`, `npm run check:secrets`, `git diff --check` | Passed |
| Actual chat-first browser smoke | 17 checks passed, including zoom restore, room/global navigation, 320/390px and tablet flows |

The complete `npm run ci:test` preflight passed before submission. The desktop notification test uses a controlled stalled body so its result does not depend on local socket startup time.

Remote CI/release, an installer build, real macOS/Linux desktop behavior and live model-host acceptance are outside these local results.

Final browser repair: React StrictMode cleanup ran before the renderer existed and replaced a valid graph snapshot with an uninitialized one. Snapshot writes now require a real renderer; restored views avoid an automatic fit competing with the saved viewport. Browser assertions failed before the fix and all 17 passed after it.
