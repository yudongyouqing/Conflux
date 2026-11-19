# Adapter audit disposition

IDs refer to the server adapter report recovered from the prior conversation. Candidate classifications are not treated as proof.

| ID | Result | Evidence / remaining review |
|---|---|---|
| B1 | Fixed | Managed event replay parses payload and strips internal instance field consistently for JSON/SSE; replay regression. |
| B2 | Fixed | HTTP accepts terminal/iterm/tmux; macOS choice regression. |
| B3 | Fixed | Required request schema and explicit API key/base URL passed to provider factory; provider SDK request interception tests. |
| B4 | Fixed / ownership boundary explicit | Uses registry runtime and native external Codex ID; managed bindings return 409 and use managed controls. Injected opener tests never spawn terminals. |
| B5 | Partial | Resolved dataDir capture, traversal rejection, hijack/response-close cleanup and end markers fixed. Whole-log JSON remains synchronous/unbounded; true run-state protocol deferred. |
| B6 | Fixed | Bodyless requests omit JSON Content-Type. |
| B7 | Fixed | Remote sessions end throws an explicit unsupported error rather than reporting success. Adding an endpoint remains a surface-parity decision. |
| B8 | Fixed | Await broadcast completion; summon returns public task_id without task_token; Web inbox type matches existing server inbox field. |
| B9 | Fixed | Request schema validates mode and nullable schedule; core validates mode. |
| B10 | Fixed | CLI forwards project_dir; HTTP export uses client selection. |
| B11 | Fixed | Hook commands open selected config, use withDb, and resolve bin symlink. Existing installed hooks are not silently rewritten. |
| B12 | Fixed | One-shot actions use withDb and stop WAL timer; channel watch closes on stop. Success/failure handle-close regression. |
| B13 | Fixed | Shared package-derived CLI/MCP/OpenAPI version; remove missing manifest entries. |
| B14 | Partial | Await missing async runtime assertions and stop operations; fix lock-test env restoration/cleanup order. Report named nonexistent upgrade-from-v8/openapi test files; actual migration suites are updated for schema 16. No blanket claim about every teardown. |
| I1 | Deferred | Raw SQL and orchestration logic remain in adapters. Module extraction overlaps ongoing managed-core work and is not needed to prove the contract fixes. |
| I2 | Partial | Positive integer IDs, room/provider bodies, public error branches and database import status repaired. Bundle parser marks pure validation errors 400. Full OpenAPI/schema/envelope completeness remains to review. |
| I3 | Partial | Shared runtime types and actual terminal registry path aligned; version, environment selection and exchange direction fixed. Registration/search/audit/timeout/delete parity decisions remain. |
| I4 | Partial | Skill workflow examples corrected in repository maintenance. Bundled/user skill synchronization and exhaustive MCP/HTTP README indexing remain. |
| I5 | Partial | Touched comments cleaned; no claim of exhaustive removal from all historical source/test comments. |
| E1 | Fixed by core/Web | Terminal discovery caching and hidden settings polling. No throughput benchmark claim. |
| E2 | Fixed | Static setLogLevel import. |
| E3 | Deferred | MCP directory refresh still performs an additional read; filtered versus complete resource signatures need care. |
| E4 | Partial | Group room membership and fetch inserted turn directly. Runtime-instance inspection/query batching remains. |
| E5 | Partial | Avoid no-op stale write acquisition; read endpoints still intentionally heartbeat/audit and may acquire write locks. |
| E6 | Partial | SSE reads bounded chunks, closes file descriptors on failure, resets truncated-file cursor, preserves UTF-8 and cleans intervals. JSON convenience log remains a whole-file read. |
| N1 | Fixed | Missing packaged file entries removed. |
| N2 | Deferred | Public compatibility re-exports retained until distribution compatibility is established. |
| N3 | Deferred | Ignored buildCli argv and obsolete-wrapper/single-item test cleanup are low-impact candidates retained. |
