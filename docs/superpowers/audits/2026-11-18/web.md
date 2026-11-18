# WEB audit disposition

Scope: recovered `agy-handoff/step-81.txt`, first report copy only; compared with current source and uncommitted diff in `.worktrees/fix/339-audit-defects` (base `94a976b`). This reconciles reported findings; it does not claim every web file was newly audited. `fixed` is source-level disposition, with root-agent validation reported separately. Integrated tests/build and screenshot inspection are tracked by the root agent and desktop disposition; this document records source reconciliation rather than duplicating that validation record. The original web report numbers Broken 1–18, then restarts numbering by section; this document assigns stable B/I/E/N IDs, preserving original subsection references.

## Broken

| ID (original) | Disposition | Current evidence / remaining work |
|---|---|---|
| B1 (1.1 #1) | partial | `api.getContext` now sends WEB_CONSOLE_ID header and AbortSignal; `useSessionContext` forwards query signal. Main 400 cause addressed. `DetailPanel` remains unchanged and does not surface query loading/error as requested. |
| B2 (1.1 #2) | fixed | `apps/web/vite.config.ts` now proxies `/data`. Performance script optional route-regex extension not changed; no assertion Settings performance scenario was exercised. |
| B3 (1.1 #3) | fixed | Server runtime request interface/schema includes `execution_mode: terminal|managed`; no longer stripped at boundary. Same as CORE B18.4 fixed portion. |
| B4 (1.1 #4) | fixed | Server terminal schema now includes terminal/iterm/tmux. Same as CORE B18.2. |
| B5 (1.1 #5) | deferred | Runtime list/schema still expose all RUNTIME_IDS, while `createRuntimeAgent` rejects beyond claude/codex. Decide filtered catalog versus expanded execution support. |
| B6 (1.1 #6) | deferred | `CreateAgentWizard.tsx:161` still hardcodes anthropic/openai/google/mistral/local; provider registry still implements only anthropic/openai. Requires provider support/choice decision. |
| B7 (1.1 #7) | fixed | Server connectivity test passes submitted apiKey/baseURL to SDK factories. Env preview now uses ANTHROPIC_AUTH_TOKEN/MODEL for Claude, OPENAI_API_KEY/BASE_URL for Codex, drops unused model vars, and masks entire credential values rather than partial-prefix replacement. |
| B8 (1.1 #8) | deferred | Desktop main preload still exposes only confluxDesktop/muiltchatDesktop; web PtyPanel still reads confluxPty and labels preset ID as PID. Only IME guard changed in web panel. Desktop PTY second-window path must not be confused with wiring the main web panel. User decision: integrate spawn/IPC or hide unavailable UI. |
| B9 (1.1 #9) | fixed | `api.checkInbox` response type now `{ inbox: Message[] }`, tests/fixtures adjusted. |
| B10 (1.2 #10) | partial | ChatPanel adds try/catch/finally, abort ref, signal through streamChat, ignored callbacks after abort, stream reader cleanup, and IME guards (also MentionComposer/PtyPanel). ChatPanel still initializes empty messages/conversationId on mount; loading previous conversations is deferred product work. |
| B11 (1.2 #11) | fixed in source | GraphTab keeps mounted Flow instance in state, restores viewport only when entering scope, fits composition changes, and waits for Flow/data readiness. Position rebuild also distinguishes composition changes. Browser interaction proof is separate. |
| B12 (1.2 #12) | partial | useWakeStream resets text on start, caps buffer to 256KiB, recognizes ended event/normal wake-end suffix; server emits ended for recognized marker and validates log path. This addresses reconnect duplication and normally completed historical logs. Live state still derives from new chunks/end marker, not runtime liveness: abruptly terminated logs without marker can remain live, and a marker split across 64KiB chunk boundaries is not recognized because regex tests each chunk. No universal completed/crashed-log guarantee. |
| B13 (1.2 #13) | fixed | App stores selectedSessionId, derives latest selected node from nodeMap, and uses stable selection callback. |
| B14 (1.2 #14) | fixed | useManagedEvents derives cursor from events held in the same query cache; separate cursor key removed. |
| B15 (1.2 #15) | fixed | Settings refresh invalidates all queries and awaits refreshed clear counts; import awaits this refresh. |
| B16 (1.2 #16) | fixed for reported explicit protocols | InlineMarkdown rejects explicit schemes outside http/https/mailto; javascript/data remain literal text. Relative paths remain allowed. Added tests cover dangerous schemes; no general URL-parser security audit claimed. |
| B17 (1.2 #17) | partial | App drawer registers pointercancel and unmount cleanup; CurvedPairEdge cancels rAF on unmount/cancel; GraphTab clears offset timer on unmount. AssistantsTab delete errors still have no surfaced UI handler (file unchanged). |
| B18 (1.2 #18) | deferred | web tsconfig still includes only src. Graph benchmark edges still omit id/last_interact_at; audited RuntimeAgent/RuntimeInstance test fixtures remain missing required fields. Added runtime tests do not establish test-tree TypeScript correctness. |
| B-note (capture script aside) | fixed in source | `scripts/capture/capture.mjs` updated tab labels/navigation, handles Windows process-tree stop, and uses structured process args for spaced paths; screenshot assets regenerated in diff. This disposition does not independently certify visual quality. |

## Inconsistent

I1.1–I1.3 correspond to design-token subsection 2.1, I2 to 2.2, I3 to 2.3, and I4.x to the bullet points in 2.4.

| ID | Disposition | Current evidence / remaining work |
|---|---|---|
| I1.1 (raw neutrals/backdrops) | deferred | CurvedPairEdge still has border-gray-200/text-gray-600 and gray manual handle; GraphTab still has border-slate-100 and hardcoded MiniMap gray; MarkdownText/graph-builders unchanged. Wizard still uses bg-ink/30 backdrop. No design-token remediation diff. |
| I1.2 (raw status colors/contrast) | deferred | SettingsTab still uses red/emerald raw scales; WorkspaceDetails/DetailPanel/RoomChat/etc unchanged. Wizard invalid accent CSS variable and ManagedCodexPanel success/danger text pairing remain. Reported numerical contrast depends on actual theme; no new contrast measurement performed. |
| I1.3 (shadows/classes/font floor) | partial | CONTRIBUTING font-floor text changed to 11px. Token shadow substitutions, duplicate SessionNode rings and Markdown uppercase label remain unchanged; supplied AGENTS.md rule still says 10px and no paired AGENTS/CLAUDE update is in diff. Needs consistent rule choice plus visual cleanup. |
| I2 (layout constant drift) | deferred | `layout.ts:NODE_HEIGHT=66`, `graph-builders.ts:CELL_H=98`, FRAME_W=420 and SessionNode footer/card layout remain. Dynamic rendered-height estimate was not remeasured here; no layout fix present. CONTRIBUTING layout reference cleanup alone does not fix geometry. |
| I3 (issue-number comments) | partial | use-wake-stream comment removed its reference. Theme/App/api/PtyPanel/ChatPanel/index.css/tailwind/graph-builders and other listed comments remain. No blanket compliance claim. |
| I4.1 (Settings heading order) | fixed | Settings heading/description now precede theme card. |
| I4.2 (edge order label/docs) | deferred | DetailPanel unchanged; still renders reversed chronological array with `最新在上` label. |
| I4.3 (managed startup toast) | deferred | `AssistantsTab.tsx:105` still always says a new terminal window was requested. |
| I4.4 (broadcast Markdown) | deferred | RoomChat unchanged, broadcast body raw string path remains. |
| I4.5 (raw English status) | deferred | MessageCard still displays status directly. User review requested in original report; avoid changing test contract without deciding localization. |
| I4.6 (web-console literals) | deferred | api summon/orchestrate and Sidebar/WorkspaceDetails/ChatRoomWizard/RoomChat remain literal strings; no shared-constant cleanup. |
| I4.7 (HTML language / HMR CSP) | deferred | `apps/web/index.html:2` still lang=en; CSP still explicitly allows only ws://127.0.0.1:5173 for HMR. |
| I4.8 (test lint/format/ci aggregation) | partial | Root `ci:test` now includes web tests. ESLint/format web test inclusion and web test type checking remain unchanged. |

## Inefficient

| ID | Disposition | Current evidence / remaining work |
|---|---|---|
| E1 | fixed for hidden-tab polling | App passes `active` to SettingsTab; interval only exists while active and cancels response writes; counts refresh on activation; useTerminalSettings disabled when hidden. The active interval still calls API directly separately from query hook, so a shared React Query polling refactor remains optional. |
| E2 | deferred | MessageTab still calls useSessions(active); CreateAgentWizard still calls useSessions(all), despite graph availability. No redundant subscription removal. |
| E3 | partial | CurvedPairEdge label measurement useLayoutEffect now depends on label, avoiding every-render layout read. SessionNode/GroupFrame/CurvedPairEdge still plain exported functions without memo wrapping. |
| E4 | deferred | MarkdownText still declares inner Code per render and builds components map inline; no memo/hoist change. |
| E5.1 (double parse) | deferred | `workspace-state.ts:54` still calls JSON.parse twice. |
| E5.2 (render lookups) | deferred | WorkspaceDetails unchanged; repeated find/some/filter operations remain. |
| E5.3 (bundle/dependencies) | deferred | Dagre remains devDependency; highlight.js not explicitly declared; no chunk-splitting configuration added. Need distinguish optional chunk split from concrete dependency declarations. |

## No longer needed

| ID | Disposition | Current evidence / remaining work |
|---|---|---|
| N1 | deferred | graph-builders still exports applyChatRoomGroups and its associated legacy type/helper; no deletion diff. |
| N2 | deferred | App still owns selectedMessage; DetailPanel/MessageTab/WorkspaceDetails/MessageCard props and unreachable message branch unchanged. |
| N3 | deferred | theme-bootstrap still calls installTheme then applySavedCustomTheme; wrappers remain. |
| N4 | deferred | API conversation/settings methods/types remain unused in current UI. Decide history integration versus removal (related B6/B10). |
| N5.1 (hook/type exports) | deferred | ManagedEvent export and useSessions still present; useSessions currently has production callers, so it is not removable until E2 is implemented. |
| N5.2 (uncontrolled instance mode) | deferred | RuntimeInstancesPanel optional self-query path unchanged. |
| N5.3 (desktop globals/types) | deferred | vite-env still declares showWindow/muiltchatDesktop and omits setNativeTheme despite actual desktop preload exposure. Compatibility-global removal needs review; add missing type separately. |
| N5.4 (reserved Tailwind tokens) | deferred | Tailwind config unchanged; choose whether to preserve reserved design primitives rather than deleting based only on current callsites. |
| N5.5 (unused test bindings) | deferred | managed-codex cursors and hooks result bindings not removed in current diff. |

No false-positive disposition was justified from the inspected current source. Unresolved report items are explicitly retained for user review; `Confident fix` in the recovered report is the original recommendation, not evidence that it was implemented. Design-token/layout and cleanup groups must not be included in a claim that all confident findings were fixed.

## Final integrated additions

An existing event-driven status test exposed an initial-fetch race: invalidation joined the initial request and did not guarantee a read after the event. The hook now schedules one follow-up invalidation after that initial snapshot. The focused regression and full 150-test Web suite pass. Assistants tests now configure mutation GC lifetime as well as clearing clients, removing retained 5-minute timers. Real-browser graph remount validation is tracked in the audit index.

Graph browser validation completed: StrictMode uninitialized cleanup no longer overwrites saved state; initial-fit restoration conflict removed. The actual chat-first smoke passed all 17 checks, including room zoom restoration and narrow/tablet workflows.
