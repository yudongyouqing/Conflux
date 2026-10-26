# Performance Baseline

Conflux records lightweight development and production measurements without
collecting telemetry or sending data off the machine.

The server logs one `http request completed` record per request through Pino.
Each record includes `method`, `url`, `statusCode`, and `durationMs`. The
existing `MUILTCHAT_LOG_FILE` setting can redirect these records to a local
file for comparison between releases.

The web graph view emits a browser debug record named `[conflux:perf] graph
build` whenever polled graph data is transformed. It includes the rendered
node count, edge count, and build duration in milliseconds. Use the browser
performance console with a representative fixture before changing layout or
React Flow memoization.

These measurements are a baseline, not a remote monitoring service. Add a
regression threshold only after collecting representative values for small,
medium, and large graphs.
