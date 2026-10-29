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
