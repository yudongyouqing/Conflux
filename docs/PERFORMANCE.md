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
