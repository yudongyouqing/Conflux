import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:9527";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Bundle the shared workspace package from TS source: the web app's
      // first RUNTIME import from it tripped rollup's CJS interop on the
      // tsc-emitted dist, and source aliasing keeps dev/build identical.
      "@conflux/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/graph": API_TARGET,
      "/messages": API_TARGET,
      "/edges": API_TARGET,
      "/sessions": API_TARGET,
      "/context": API_TARGET,
      "/agents": API_TARGET,
      "/conversations": API_TARGET,
      "/settings": API_TARGET,
      "/audit": API_TARGET,
      "/healthz": API_TARGET,
      "/docs": API_TARGET,
      "/web": API_TARGET,
      "/runtimes": API_TARGET,
    },
  },
});
