import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.CODEX_WEB_PORT ?? "4310";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5902,
    strictPort: true,
    allowedHosts: ["codex.example.com", "codex.example.cn"],
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
