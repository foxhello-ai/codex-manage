import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRuntimeRoutes } from "./runtime";
import { RuntimeReloadBlockedError } from "../services/AppRuntime";

describe("runtime routes", () => {
  it("reloads app-server and invalidates model cache", async () => {
    const app = Fastify();
    const reloadAppServer = vi.fn(async () => ({
      generation: 1,
      reloadedAt: "2026-07-28T00:00:00.000Z",
      trigger: "manual" as const,
      reason: null,
      codexCliVersion: "codex-cli 0.144.3",
      appServer: { status: "ready" as const, pid: 123, lastError: null, initialized: true }
    }));
    const invalidate = vi.fn();

    registerRuntimeRoutes(app, { reloadAppServer } as any, { invalidate } as any);

    const response = await app.inject({ method: "POST", url: "/api/runtime/reload", payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runtime: { generation: 1, trigger: "manual" } });
    expect(reloadAppServer).toHaveBeenCalledWith({ trigger: "manual", reason: null });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("returns blockers when app-server reload is unsafe", async () => {
    const app = Fastify();
    registerRuntimeRoutes(
      app,
      {
        reloadAppServer: async () => {
          throw new RuntimeReloadBlockedError([
            { threadId: "thread-1", status: "running", reason: "active_runtime" }
          ]);
        }
      } as any,
      { invalidate: vi.fn() } as any
    );

    const response = await app.inject({ method: "POST", url: "/api/runtime/reload", payload: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "RUNTIME_RELOAD_BLOCKED",
        details: { blockers: [{ threadId: "thread-1", reason: "active_runtime" }] }
      }
    });
  });
});
