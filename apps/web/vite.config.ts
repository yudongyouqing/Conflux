import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = "http://localhost:9527";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/graph": API_TARGET,
      "/messages": API_TARGET,
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
