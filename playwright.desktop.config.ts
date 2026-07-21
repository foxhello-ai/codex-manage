import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/desktop",
  testMatch: "**/*.e2e.ts",
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list"
});
