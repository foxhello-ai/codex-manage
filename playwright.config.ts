import { defineConfig } from "@playwright/test";

const port = Number(process.env.CODEX_E2E_PORT ?? 3014);
const password = process.env.CODEX_E2E_PASSWORD ?? "fmzh2026";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  outputDir: "test-results/playwright",
  use: {
    baseURL,
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.CODEX_E2E_CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: ["--no-sandbox"]
    }
  },
  projects: [
    {
      name: "desktop",
      use: {
        viewport: { width: 1440, height: 960 }
      }
    },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true
      }
    }
  ],
  webServer: {
    command: `CODEX_WEB_HOST=127.0.0.1 CODEX_WEB_PORT=${port} CODEX_WEB_PASSWORD=${password} npm start`,
    url: `${baseURL}/api/me`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
