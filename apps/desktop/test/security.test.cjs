const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAllowedNavigation,
  externalLinkDecision,
  productionCsp,
} = require("../src/security.cjs");

const APP_ORIGIN = "http://127.0.0.1:9527";

test("allows paths on the local Conflux origin", () => {
  assert.equal(
    isAllowedNavigation(`${APP_ORIGIN}/sessions?selected=one#messages`, APP_ORIGIN),
    true
  );
});

test("rejects navigation when protocol, host, or port differs", () => {
  assert.equal(isAllowedNavigation("https://127.0.0.1:9527/", APP_ORIGIN), false);
  assert.equal(isAllowedNavigation("http://localhost:9527/", APP_ORIGIN), false);
  assert.equal(isAllowedNavigation("http://127.0.0.1:5173/", APP_ORIGIN), false);
  assert.equal(isAllowedNavigation("not a url", APP_ORIGIN), false);
});

test("routes safe non-Conflux HTTP links to the system browser", () => {
  assert.deepEqual(
    externalLinkDecision("https://example.com/docs", APP_ORIGIN),
    { action: "external", url: "https://example.com/docs" }
  );
  assert.deepEqual(
    externalLinkDecision(`${APP_ORIGIN}/inside`, APP_ORIGIN),
    { action: "allow" }
  );
});

test("denies malformed and executable external URLs", () => {
  assert.deepEqual(externalLinkDecision("javascript:alert(1)", APP_ORIGIN), {
    action: "deny",
  });
  assert.deepEqual(externalLinkDecision("not a url", APP_ORIGIN), {
    action: "deny",
  });
});

test("builds a production CSP with only local API connectivity", () => {
  const csp = productionCsp(APP_ORIGIN);

  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:9527/);
  assert.doesNotMatch(csp, /connect-src[^;]*https:\/\/example\.com/);
});
