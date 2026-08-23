import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const apiPort = process.env.CODEX_WEB_API_PORT ?? "4311";

const SUPPORTED_BRANDS = new Set(["base", "fmzh"]);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const brand = resolveBrand(env.CODEX_BRAND ?? env.VITE_BRAND);

  return {
    plugins: [react(), brandingIndexPlugin(brand)],
    server: {
      port: 4310,
      strictPort: true,
      allowedHosts: ["codex.example.com", "codex.example.cn", "codex.foxhello.cn"],
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
  };
});

function resolveBrand(value: string | undefined): string {
  const brand = value?.trim().toLowerCase() || "base";
  if (!SUPPORTED_BRANDS.has(brand)) {
    throw new Error(`Unsupported CODEX_BRAND "${brand}". Expected one of: ${[...SUPPORTED_BRANDS].join(", ")}`);
  }
  return brand;
}

function brandingIndexPlugin(brand: string): Plugin {
  return {
    name: "codex-branding-index",
    transformIndexHtml(html) {
      return html.replaceAll("__CODEX_BRAND__", brand);
    }
  };
}
