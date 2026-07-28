import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import { registerConfigRoutes } from "./config";

function testConfig(): AppConfig {
  return {
    host: "0.0.0.0",
    port: 5902,
    password: "fmzh2026",
    defaultPassword: true,
    sessionSecret: "test-secret-at-least-thirty-two-chars",
    codexCliPath: "/usr/local/bin/codex",
    sessionsDir: "/home/test/.codex/sessions",
    metadataFile: "/tmp/codex-manage-test-session-metadata.json",
    clientDir: "/tmp/codex-manage-test-client"
  };
}

describe("config and health routes", () => {
  it("returns effective read-only configuration and healthy diagnostics", async () => {
    const app = Fastify();
    registerConfigRoutes(app, testConfig(), () => ({
      codexCliVersion: "codex-cli 0.144.3",
      codexVersionError: null,
      appServer: { status: "ready", pid: 1234, lastError: null, initialized: true },
      runtimeReload: { generation: 0, reloadedAt: null, trigger: null, reason: null, lastError: null }
    }));

    const configResponse = await app.inject({ method: "GET", url: "/api/config" });
    const healthResponse = await app.inject({ method: "GET", url: "/api/health" });

    expect(configResponse.statusCode).toBe(200);
    expect(configResponse.json()).toMatchObject({
      host: "0.0.0.0",
      port: 5902,
      defaultPassword: true,
      codexCliVersion: "codex-cli 0.144.3",
      appServer: { status: "ready", initialized: true }
    });
    expect(healthResponse.json()).toMatchObject({
      ok: true,
      codexCli: { available: true, version: "codex-cli 0.144.3", error: null },
      appServer: { status: "ready", initialized: true }
    });
    expect(Date.parse(healthResponse.json().checkedAt)).not.toBeNaN();
  });

  it("reports CLI and app-server failures without hiding the diagnostic", async () => {
    const app = Fastify();
    registerConfigRoutes(app, testConfig(), () => ({
      codexCliVersion: null,
      codexVersionError: "codex executable not found",
      appServer: { status: "failed", pid: null, lastError: "spawn codex ENOENT", initialized: false },
      runtimeReload: { generation: 0, reloadedAt: null, trigger: null, reason: null, lastError: null }
    }));

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      codexCli: { available: false, error: "codex executable not found" },
      appServer: { status: "failed", lastError: "spawn codex ENOENT", initialized: false }
    });
  });
});
