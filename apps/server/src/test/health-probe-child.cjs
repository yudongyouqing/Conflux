// Independent health-probe client for lock-contention tests. Runs as a
// separate process so it keeps requesting while the server's event loop is
// frozen by a synchronous SQLite busy-wait — an in-process client shares
// that loop and could never observe the freeze.
//
// usage: node health-probe-child.cjs <baseUrl> <intervalMs>
// Prints one JSON line per probe: {sentAt, receivedAt, status, err}
// (milliseconds since process start). Runs until killed.
const http = require("node:http");
const { performance } = require("node:perf_hooks");

const [baseUrl, intervalArg] = process.argv.slice(2);
const intervalMs = Number(intervalArg) || 400;
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

const started = performance.now();

function probe() {
  const sentAt = performance.now() - started;
  const request = http.request(
    `${baseUrl}/healthz`,
    { agent, method: "GET" },
    (response) => {
      response.resume();
      response.on("end", () => {
        process.stdout.write(
          `${JSON.stringify({ sentAt: Math.round(sentAt), receivedAt: Math.round(performance.now() - started), status: response.statusCode })}\n`,
        );
        schedule();
      });
    },
  );
  request.on("error", (error) => {
    process.stdout.write(
      `${JSON.stringify({ sentAt: Math.round(sentAt), receivedAt: Math.round(performance.now() - started), status: null, err: error.code ?? error.message })}\n`,
    );
    schedule();
  });
  request.end();
}

function schedule() {
  // Intentionally ref'd: the probe must keep polling until the parent
  // kills it — an unref'd timer lets the loop drain once the keep-alive
  // socket goes idle and polling silently stops.
  setTimeout(probe, intervalMs);
}

probe();
