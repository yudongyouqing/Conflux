const http = require("node:http");

function requestJson(url, { agent, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = http.request(
      url,
      {
        agent,
        method: payload === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: {
          "X-Session-Id": "perf-0",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024 * 1024) response.destroy(Error("Response exceeds 64 MiB"));
          else chunks.push(chunk);
        });
        response.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        response.on("end", () => {
          clearTimeout(timer);
          try {
            if (response.statusCode !== 200) throw Error(`HTTP ${response.statusCode}`);
            resolve({ json: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(payload);
  });
}

module.exports = { requestJson };
