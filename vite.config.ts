import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.CODEX_WEB_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:" + apiPort,
        ws: true
      }
    }
  },
  build: {
    outDir: "dist/client"
  }
});
