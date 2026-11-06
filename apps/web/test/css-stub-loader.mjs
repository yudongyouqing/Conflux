// Test-only module loader: React Flow ships a CSS side-effect import that
// Node cannot parse. The browser bundler handles it; for JSDOM tests we
// short-circuit any .css specifier to an empty module. Registered from
// workspace.test.ts BEFORE the graph view's lazy import fires.
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) {
    return {
      shortCircuit: true,
      url: "data:text/javascript;charset=utf-8,export default null",
    };
  }
  return next(specifier, context);
}
