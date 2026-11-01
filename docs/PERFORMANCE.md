# Performance Baseline

Conflux records lightweight development and production measurements without
collecting telemetry or sending data off the machine.

The server logs one `http request completed` record per request through Pino.
Each record includes `method`, `url`, `statusCode`, and `durationMs`. The
existing `CONFLUX_LOG_FILE` setting can redirect these records to a local
file for comparison between releases.

The web graph view emits a browser debug record named `[conflux:perf] graph
build` whenever polled graph data is transformed. It includes the rendered
node count, edge count, and build duration in milliseconds. Use the browser
performance console with a representative fixture before changing layout or
React Flow memoization.

These measurements are a baseline, not a remote monitoring service. Add a
regression threshold only after collecting representative values for small,
medium, and large graphs.

## Initial graph construction baseline

Run from the repository root after `npm ci` and `npm run build -w packages/shared`:

```sh
node --import tsx apps/web/test/graph-benchmark.ts
```

The fixtures are active sessions arranged as a directed chain, a binary tree,
or disconnected nodes. It measures `buildActiveView`, including graph layout, in Node.js;
it does not measure React rendering, browser interaction, server latency, or
memory. Each size has three warm-up runs followed by ten measured runs. The
median is the average of the two middle samples; max is the largest sample.

On 2026-10-28, Windows 11, Intel Core i7-12650H, approximately 16 GB RAM,
Node.js v22.23.4, using the dev source at `4dfafa2`:

| Active nodes | Edges | Median (ms) | Max (ms) |
| ---: | ---: | ---: | ---: |
| 25 | 24 | 8.68 | 10.89 |
| 100 | 99 | 28.22 | 40.25 |
| 300 | 299 | 95.63 | 105.06 |

On the same host on 2026-10-28, source `ce2658a`, an additional run compared
three synthetic topologies (three warm-ups and ten samples each):

| Topology | Nodes | Edges | Median (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: |
| Chain | 25 | 24 | 8.76 | 11.12 |
| Chain | 100 | 99 | 33.79 | 39.06 |
| Chain | 300 | 299 | 92.55 | 114.88 |
| Binary tree | 25 | 24 | 8.97 | 12.80 |
| Binary tree | 100 | 99 | 28.06 | 31.14 |
| Binary tree | 300 | 299 | 86.67 | 102.94 |
| Disconnected | 25 | 0 | 0.00 | 0.01 |
| Disconnected | 100 | 0 | 0.01 | 0.02 |
| Disconnected | 300 | 0 | 0.05 | 0.08 |

Disconnected graphs use the grid fallback rather than Dagre, so their timings
are not directly comparable to connected graphs. These observations are not
pass/fail limits. Machine load and graph topology affect results. Collect
repeated runs on representative hardware and dense graphs, plus browser
rendering measurements, before choosing thresholds.

## Browser verification

```sh
npm ci
npx playwright install chromium
npm run perf:web
```

`perf:web` builds the production app, serves it on an ephemeral loopback port,
and runs headless Chromium at 1440 脳 900 with deterministic API fixtures. It
does not access a running Conflux server or user database. The fixtures contain
25, 100, or 300 active sessions in chains, binary trees, or disconnected graphs.
Each case discards one warm-up navigation and records five new-context
navigations; HTTP cache is cold in each context. Set `PERF_SAMPLES` to an integer
of at least three to change the sample count.

- `renderedMs`: navigation start to automation-observed node and edge counts,
  loaded fonts, and two animation frames. This includes JS loading, layout,
  DOM creation and automation observation overhead. It is a repeatable readiness
  proxy, not a guarantee of full paint completion or a Core Web Vital.
- `zoomMs`: a DOM click on the actual zoom-in control to a changed viewport
  transform followed by two animation frames. The initial fit-view animation
  is given one second to settle before measurement. This measures first visual
  response, not animation completion or hardware input latency.
- `longTasks`: durations of main-thread tasks reported by Chromium's Long Tasks
  API (at least 50 ms) from navigation through the zoom measurement.

The report at `test-results/performance/browser.json` contains every raw sample,
medians, maxima, git revision, date, viewport, CPU, memory, OS, Node and Chromium
versions. The CI `browser-performance` job retains this JSON as an artifact.
Runtime errors, missing nodes/edges or a zoom that does not change the viewport
fail the run. Timing values are observations, not CI speed gates: compare runs
on the same hardware and browser before deciding regression thresholds.

This benchmark excludes server/SQLite latency, real network delay, Electron
startup, GPU/device diversity and real-world graph density. Use the existing
server HTTP logs for service timings and repeat these fixtures on representative
devices and real data before extrapolating capacity.

### Windows browser observation (2026-10-28)
Chromium 156.0.8078.4, win32 10.0.26300, 12th Gen Intel(R) Core(TM) i7-12650H, Node v22.23.4.
Five measured navigations per case after one discarded navigation. Raw data: [browser report](performance/2026-10-28-browser.json).
| Topology | Nodes | Ready median (ms) | Zoom median (ms) | Long-task max (ms) |
| --- | ---: | ---: | ---: | ---: |
| chain | 25 | 251.6 | 24.1 | 0.0 |
| chain | 100 | 372.8 | 20.1 | 56.0 |
| chain | 300 | 839.1 | 86.9 | 169.0 |
| tree | 25 | 255.6 | 27.6 | 0.0 |
| tree | 100 | 364.4 | 23.9 | 61.0 |
| tree | 300 | 822.5 | 94.4 | 146.0 |
| disconnected | 25 | 211.6 | 26.9 | 0.0 |
| disconnected | 100 | 243.9 | 27.6 | 0.0 |
| disconnected | 300 | 407.2 | 27.9 | 105.0 |

The connected 300-node fixtures show main-thread tasks above 100 ms. Use this as an optimization target and remeasure on the same environment; these samples do not establish a cross-device capacity limit.

## Long directed path optimization (2026-10-29)

Source `5f128fc` recognizes connected directed paths with at least eight nodes
and uses the existing snake layout immediately. Other graphs retain Dagre's
two-direction layout. This avoids computing two layouts that the old algorithm
discarded for long paths. Node positions and edge arrays were checked for exact
equality with the previous implementation at 8, 25, 100 and 300 nodes.

On this Windows host, alternating old (`8ec85cb`) and new implementations in one
process, with three warm-ups and ten samples per size, gave these layout-only
medians (this excludes React conversion and rendering):

| Nodes | Before (ms) | After (ms) |
| ---: | ---: | ---: |
| 8 | 3.68 | 0.02 |
| 25 | 11.22 | 0.06 |
| 100 | 38.09 | 0.14 |
| 300 | 107.04 | 0.37 |

The production browser benchmark then recorded five measured navigations per
case after a discarded warm-up. Raw data and environment metadata are in
[the 2026-10-29 report](performance/2026-10-29-browser.json).

| Topology | Nodes | Ready median (ms) | Zoom median (ms) | Long-task max (ms) |
| --- | ---: | ---: | ---: | ---: |
| chain | 25 | 231.0 | 19.0 | 0.0 |
| chain | 100 | 267.3 | 21.0 | 0.0 |
| chain | 300 | 487.7 | 57.2 | 104.0 |
| tree | 25 | 236.3 | 18.4 | 0.0 |
| tree | 100 | 324.5 | 26.5 | 50.0 |
| tree | 300 | 613.7 | 64.7 | 113.0 |
| disconnected | 25 | 193.7 | 25.0 | 0.0 |
| disconnected | 100 | 227.2 | 23.7 | 0.0 |
| disconnected | 300 | 404.2 | 31.2 | 78.0 |

The historical 300-node chain readiness median was 839.1 ms; this run measured
487.7 ms. These browser runs occurred at different times, so environment noise
can contribute to the difference. Zoom improvements are observations, not a
claimed direct effect of layout changes. Trees were not optimized; React/DOM
work still creates long tasks and remains a separate optimization target.

## Server HTTP and SQLite baseline (2026-10-30)

Run from the repository root:

```sh
npm run test:perf:server
npm run perf:server
```

Both commands build shared contracts and the server. No additional dependency is
required. The benchmark uses compiled production core modules and a separate
server child process on an ephemeral `127.0.0.1` port. All databases, logs and
home/config paths are temporary; it never targets an existing service or user
database. INFO request logging to a temporary file stays enabled. UI assets,
real model providers and network services are outside this benchmark.

The fixture is a directed ring of 25, 100 or 300 synthetic sessions, with 10
messages and two context entries per session; every fifth context matches the
FTS query `needle`. SQLite and HTTP phases use separate freshly seeded files.
HTTP adds the normal `web-console` pseudo-session. Only seeding runs inside an
outer transaction; measured inserts retain normal autocommit and FTS triggers.
Each operation discards ten warm-up observations, then records 100 samples.
HTTP runs at concurrency 1 and 8 with keep-alive sockets and closed-loop load.
There are six SQLite cases and ten HTTP cases per fixture: 4,800 measured
observations in total, plus warm-ups and untimed correctness probes.

SQLite timings cover the real core functions, including statement preparation,
queries and result conversion. HTTP latency covers the entire JSON response and
client parsing in a separate process. Correctness assertions are excluded from
individual latency but included in wall throughput and CPU. p50/p95 use nearest
rank. Successful operations per second are observed under that closed-loop
workload; they are not maximum capacity or an open-loop load-test result.

Read cases run before inserts. Warm-up writes remain in the database: SQLite
ends with 110 extra messages and 110 extra contexts; HTTP ends with 220 extra
contexts. Context query and publication also perform the normal heartbeat/audit
writes. Final row counts and FTS lookups verify committed inserts. Seed/build
time is excluded; `startupMs` measures `startHttpServer` with modules already
loaded, not a cold process or Electron launch.

Output: `test-results/performance/server-database.json`. It contains every raw
latency, failures, before/after row counts, database/WAL/SHM bytes, SQLite
pragmas, server/client CPU deltas, RSS/heap snapshots, process-lifetime maximum
RSS, source revision and environment. CPU snapshots include driver/IPC overhead.
RSS is a snapshot; lifetime maximum RSS includes seeding and earlier cases and
must not be read as a per-case peak or a memory-leak diagnosis. Source `dirty`
tracks benchmark/server/shared/manifests/CI files, including new benchmark files.
The CI `server-performance` job runs the tests and benchmark, retaining
`server-database-performance` even when measurement fails. Timing is not a CI
gate; non-200 responses, malformed/incorrect JSON, wrong counts and timeouts fail.
Catchable coordinator termination cleans the child and temporary files; a
worker exits on IPC disconnect. Uncatchable process termination can leave a
temporary directory and cannot guarantee a final report.

Optional environment settings (PowerShell: `$env:NAME = "value"`; clear overrides
after experiments before collecting default baseline reports):

| Setting | Default | Accepted values |
| --- | --- | --- |
| `PERF_SERVER_SIZES` | `25,100,300` | Unique comma-separated session counts, 2–3000 |
| `PERF_SERVER_SAMPLES` | `100` | Integer 20–10000 per operation |
| `PERF_SERVER_WARMUP` | `10` | Integer 1–1000 |
| `PERF_SERVER_CONCURRENCY` | `1,8` | Unique comma-separated concurrency levels, 1–64 |
| `PERF_SERVER_OUTPUT` | `test-results/performance/server-database.json` | Report path |

Each request has a 10-second deadline, IPC a 30-second deadline, and each fixture
a 180-second overall deadline. The CI job has a ten-minute limit; unusually large
custom settings can reach these limits and are not a supported capacity claim.

### Windows observation

Source `24ce67c`, clean measurement sources; v22.23.4, Windows 10.0.26300, 12th Gen Intel(R) Core(TM) i7-12650H, approximately 15.7 GiB RAM; SQLite 3.53.4. WAL, synchronous=NORMAL, 4096-byte pages, 1000-page autocheckpoint and 10-second busy timeout. This run was collected without concurrent project build/test jobs. Raw data: [server/database report](performance/2026-10-30-server-database.json). All 4,800 measured operations passed.

SQLite p50 / p95 in milliseconds:

| Operation | 25 sessions | 100 sessions | 300 sessions |
| --- | ---: | ---: | ---: |
| sessions-list | 0.130 / 0.362 | 0.280 / 0.361 | 0.811 / 1.023 |
| graph | 0.357 / 0.430 | 0.854 / 0.960 | 2.378 / 2.646 |
| messages-list-50 | 0.065 / 0.123 | 0.060 / 0.085 | 0.056 / 0.082 |
| context-fts-25 | 0.071 / 0.105 | 0.114 / 0.153 | 0.201 / 0.250 |
| message-insert | 0.196 / 0.300 | 0.188 / 0.284 | 0.183 / 0.318 |
| context-insert-fts | 0.120 / 0.215 | 0.084 / 0.134 | 0.096 / 0.178 |

HTTP at 300 sessions, 3,000 initial messages and 600 initial contexts:

| Operation | Concurrency | p50 (ms) | p95 (ms) | Successful requests/s |
| --- | ---: | ---: | ---: | ---: |
| health | 1 | 0.275 | 0.388 | 3425.9 |
| health | 8 | 0.789 | 1.181 | 9173.7 |
| graph | 1 | 4.444 | 5.665 | 215.5 |
| graph | 8 | 27.406 | 30.593 | 288.8 |
| messages-list-50 | 1 | 0.480 | 0.595 | 1952.2 |
| messages-list-50 | 8 | 2.207 | 4.863 | 3308.4 |
| context-fts-25 | 1 | 0.891 | 1.375 | 889.8 |
| context-fts-25 | 8 | 5.153 | 11.909 | 1362.8 |
| context-insert-fts | 1 | 0.648 | 0.854 | 1260.3 |
| context-insert-fts | 8 | 3.904 | 10.308 | 1592.4 |

Graph HTTP scaling (p95 milliseconds / observed successful requests per second):

| Sessions | Concurrency 1 | Concurrency 8 |
| ---: | ---: | ---: |
| 25 | 1.209 / 966.5 | 7.868 / 1314.1 |
| 100 | 2.008 / 566.0 | 13.415 / 696.8 |
| 300 | 5.665 / 215.5 | 30.593 / 288.8 |

Resource observations at 300 sessions (per 100 measured requests):

| Operation | Concurrency | Server CPU user+system (ms) | Server RSS after (MiB) |
| --- | ---: | ---: | ---: |
| graph | 1 | 358.0 | 184.7 |
| graph | 8 | 328.0 | 183.7 |
| context-insert-fts | 1 | 47.0 | 171.8 |
| context-insert-fts | 8 | 77.0 | 172.8 |

Increasing concurrency raises graph latency while only modestly improving its
observed throughput. Use the graph endpoint as a profiling target; these data
do not establish its internal bottleneck or justify a schema/index change.
The synthetic ring, small payloads, warm OS cache and single Node/SQLite writer
exclude dense graphs, real data distributions, cold disks, multi-process writer
contention, long-running memory growth and device diversity. Repeat on the same
hardware and on representative devices/data before choosing regression limits.
Multi-process contention and a long-running soak are covered separately in the
sections below.

## Cross-process SQLite contention (2026-11-01)

```sh
npm run perf:contention          # full run, report to test-results/performance/contention.json
node --test scripts/performance/contention.test.cjs   # short smoke of every scenario
```

The benchmark forks the real HTTP server (built `apps/server/dist`) and an
external CLI/MCP-style writer process against **one temporary SQLite file**.
Lock state is never guessed from sleeps: the writer acknowledges `BEGIN
IMMEDIATE` and every release over IPC before victims run. The writer's
test-only second connection shortens its own `busy_timeout` to observe timeout
classification quickly; production connections keep `busy_timeout = 10000`
from `core/db.ts`, which is unchanged.

Scenarios and the observations recorded in
[the 2026-11-01 report](performance/2026-11-01-contention.json)
(Windows 11, i7-12650H, 16 GB, Node v22.23.4, source `d0f3ee4`, clean tree):

| Scenario | Observation |
| --- | --- |
| read-during-uncommitted-write | `/healthz` (write-free) stayed available during the hold; a second-connection reader saw 0 of the 3 uncommitted rows and all 3 after commit. An audited data read (`/context/query`) fired during the hold returned only after the release (2.8 ms with a ~1 ms release): audited reads join write contention through their audit/heartbeat rows. |
| release-recovery | A write fired while the lock was held succeeded after the release: 170.7 ms total wait (includes the 150 ms arrival cushion), 16.8 ms from release acknowledgement to response, exactly one row. |
| short-timeout-victim | With `busy_timeout = 50` the victim write failed with `SQLITE_BUSY`, left zero rows, and a retry after the release succeeded in 0.8 ms. |
| production-timeout | Against a hold longer than 10 s the HTTP write returned `503`/`DATA_LOCKED` after 21.8 s: the insert busy-waits the full 10 s, then the error path's own audit write waits on the still-held lock for roughly another 10 s before the reply. A follow-up write succeeded 9.3 ms after the release. |
| two-writer-burst | 120 HTTP writes and 120 external writer inserts interleaved on one file: all succeeded with zero lock errors (busy_timeout absorbed the contention); HTTP write p50 1.1 ms / p95 8.9 ms, writer-side inserts p50 0.2 ms. FTS found exactly the 240 distinct markers; both processes observed identical row counts — no duplicates, no losses. |
| writer-death-recovery | Killing the writer mid-transaction released the lock; all 3 uncommitted rows were rolled back; a follow-up write succeeded 1.8 ms later. |

Run totals: 123 writes succeeded, 1 expected lock error (the deliberate
production-timeout case), 0 unexpected errors, 10/10 reads succeeded. The WAL
reached 4.3 MB against a 376 KB database with active readers preventing a
truncating checkpoint. The audited-read and double-timeout behaviors are
observations about the current audit design, recorded rather than changed.
These are single-machine observations on loopback with synchronous
better-sqlite3 — not pass/fail limits and not capacity claims.

## Long-running soak (2026-11-01)

```sh
npm run perf:soak    # configurable via PERF_SOAK_* environment variables
node --test scripts/performance/soak.test.cjs   # short smoke (CI)
```

The soak runs the seeded HTTP server while a coordinator samples it every
second over IPC: worker RSS/heap/external, cumulative CPU, database/WAL/shm
bytes, page counts, row counts and coordinator active handles, all stored as
a time series. A **fixed phase** (reads only) precedes a **write phase** with
paced `POST /context` writes, separating steady-state read memory from
growth caused by inserted data. The write pacer runs on its own loop (one
interval after each completion) so slow sampling cannot starve the load; the
sampler sleeps until the next due tick instead of polling (`idleWakeups`
counts wakes that found nothing due); and a run whose acknowledged writes
fall below half the ideal cadence fails integrity — a write phase that wrote
nothing cannot pass. CI runs the short smoke only; long runs are
intentionally local and never become CI gates.

The recorded 30-minute run on the fixed harness
([v2 report](performance/2026-11-01-soak-v2.json), same host and clean
source `565cc98`) used a 5-minute fixed phase and a 25-minute write phase
(250 ms pacing, 1 s sampling):

| Observation | Value |
| --- | --- |
| Reads | 300 fixed + 1,500 write-phase reads, all succeeded, 0 unexpected errors |
| Writes | 5,691 attempted / 5,691 acknowledged / 0 lock errors / 0 unexpected errors (completion pacing lands slightly under the 6,000 ideal) |
| Integrity | contexts 50 → 5,741 rows, exactly the 5,691 unique acknowledged ids; minimum-writes gate 3,000 met; FTS marker sampling verified |
| Worker RSS | first 91.0 MB, last 85.5 MB, min 71.5 MB, max 93.4 MB — ended below its start after the full run |
| Worker heapUsed | 27.6 MB → 22.6 MB (max 28.6) — GC sawtooth, no monotone trend |
| Worker external | +0.1 MB over 30 minutes |
| Worker CPU | ≈0.27 core-minutes total across the 30 minutes |
| Coordinator RSS | +8.8 MB — the harness itself accumulates acknowledged ids and samples; expected data growth, not a server observation |
| Scheduler | idleWakeups 302 fixed / 1,507 write — ≈1 per sample, no clock polling |
| Database / WAL | database +2.9 MB (5,691 contexts + 6,141 audit rows); WAL sawtooth bounded at 4.0 MB by `wal_autocheckpoint` |

The first 30-minute run
([v1 report](performance/2026-11-01-soak.json), source `d0f3ee4`) is kept as
historical evidence: its harness polled the clock through the fixed phase
(`sleep(0)` loops) and could starve writes under slow sampling, so its
coordinator-side CPU is not comparable; its write cadence still hit the
6,000-write ideal (6,000/6,000 acknowledged) and its server-side series match
the v2 observations.

A single 30-minute run on one machine cannot prove the absence of a leak, and
a high-water RSS mark cannot prove one; the RSS/heap declines above are
observations under this workload, not verdicts. Slower leaks, other workflows
(MCP/CLI traffic, wake spawning), other platforms and longer horizons need
repeated runs before any conclusion. No thresholds were added to CI.
