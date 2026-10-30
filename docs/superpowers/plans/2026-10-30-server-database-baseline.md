# Server and database baseline implementation plan

**Goal:** Add reproducible SQLite core and real HTTP measurements with raw samples and correctness checks, without changing product behavior or performance gates.

**Architecture:** A coordinator forks a compiled-server worker for each synthetic fixture. The worker measures synchronous core operations, seeds a separate HTTP database, and serves on an ephemeral loopback port. The coordinator sends bounded, closed-loop HTTP traffic and obtains server resource snapshots over IPC. All data, homes and logs are temporary; reports contain no user database contents.

**Stack:** Node built-ins, existing compiled Conflux server and better-sqlite3. No additional dependencies.

- [x] Add `scripts/performance/measurement.cjs` and its Node tests. Test nearest-rank percentiles, invalid settings, bounded concurrency, warm-up exclusion and failed-request accounting before implementation.
- [x] Add `server-worker.cjs`: deterministic ring fixtures (25/100/300 sessions, 10 messages and 2 contexts per session), compiled core reads/writes and a separate HTTP database. Validate counts, returned values and persisted writes. Report SQLite pragmas, storage, CPU and process memory.
- [x] Add `server-database.cjs`: isolated child environment, IPC deadlines, real keep-alive HTTP at concurrency 1/8, bounded requests, correctness validation, reliable shutdown and failed reports. Add `perf:server` and `test:perf:server` scripts and a small end-to-end smoke.
- [x] Add a bounded CI job that runs measurement tests and the benchmark, retaining JSON even on failure. Update release config coverage for this new CI entry point.
- [x] Run the full build, affected server suite, benchmark tests, lint and secret scan. Commit implementation before measuring the documented baseline so the report identifies its exact source revision. Run the full default benchmark alone, record environment and raw JSON, and update `docs/PERFORMANCE.md` and the relevant TODO entries with remaining limits.

**Measurement rules:** Discard warm-ups. Default to 100 observations per operation, with p50/p95 using nearest rank. Measure each HTTP request until its complete JSON response arrives, including client parsing, but validate outside the latency timer. Report observed successful operations per wall second, not an open-loop capacity estimate. Core write observations are independent autocommit operations; only fixture creation uses an outer transaction. Read cases precede writes; report row counts before and after. Resource snapshots show before/after RSS and heap, CPU deltas, and process-lifetime maximum RSS, not a sampled per-case peak. Seed/setup and build time are excluded. No cold-disk, real-host, cross-process SQLite writer-contention or Electron capacity claims.

**Validation commands:** `node --test scripts/performance/*.test.cjs`, `npm run build`, `npm test -w apps/server`, `npm run lint`, `node --test scripts/release-config.test.cjs`, `npm run check:secrets`, `npm run perf:server`. A reduced smoke uses `PERF_SERVER_SIZES=8`, `PERF_SERVER_SAMPLES=20`, `PERF_SERVER_WARMUP=2`, `PERF_SERVER_CONCURRENCY=1,4`; recorded baselines use defaults, run without other build/test workloads.

**Execution evidence (2026-10-30):** server 277/277; benchmark tests 9/9; release config 3/3; full build passed; lint 0 errors/10 pre-existing warnings; secret scan passed. Independent review identified worker IPC-disconnect cleanup, now fixed with real-process tests and re-reviewed. Formal default run at `24ce67c` had clean measurement sources and 4,800 successful observations; the raw report and tables are in `docs/performance/2026-10-30-server-database.json` and `docs/PERFORMANCE.md`.
