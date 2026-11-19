import { test } from "node:test";
import assert from "node:assert/strict";
import { providerRegistry } from "../core/providers.js";

for (const provider of ["openai", "anthropic"]) {
  test(`${provider} connectivity uses supplied credentials and endpoint`, async () => {
    const { generateText } = await import("ai");
    const originalFetch = globalThis.fetch;
    const requests: { url: string; headers: Headers }[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ error: { type: "authentication_error", message: "fixture rejection" } }), { status: 401, headers: { "content-type": "application/json" } });
    };
    try {
      const model = await providerRegistry[provider].loadModel("fixture-model", { apiKey: "fixture-key", baseURL: "https://fixture.invalid/v1" });
      await assert.rejects(generateText({ model, prompt: "hi", maxRetries: 0 }));
      assert.equal(requests.length, 1);
      assert.ok(requests[0].url.startsWith("https://fixture.invalid/v1/"));
      assert.equal(requests[0].headers.get(provider === "openai" ? "authorization" : "x-api-key"), provider === "openai" ? "Bearer fixture-key" : "fixture-key");
    } finally { globalThis.fetch = originalFetch; }
  });
}
