import { defineConfig } from "@playwright/test";

const executablePath = process.env.CODEX_E2E_CHROMIUM_PATH;
const port = Number(process.env.CODEX_UI_PORT ?? 4317);
export default defineConfig({
  testDir: "tests/ui",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 2,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/ui", open: "never" }], ["json", { outputFile: process.env.CODEX_UI_RESULTS ?? "docs/acceptance/2026-11-03-h5-ui-refinement/playwright-results.json" }]],
  outputDir: "test-results/ui",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath }
  },
  projects: [
    ...[320, 375, 390, 430].map((width) => ({ name: `mobile-${width}`, use: { viewport: { width, height: 844 }, isMobile: true, hasTouch: true } })),
    { name: "iphone-16-pro", use: { viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
    { name: "landscape-736", use: { viewport: { width: 736, height: 375 }, isMobile: true, hasTouch: true } },
    { name: "landscape-844", use: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1440, height: 960 } } }
  ],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false
  }
});
