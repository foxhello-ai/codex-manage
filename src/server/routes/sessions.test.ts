import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSessionRoutes } from "./sessions";
import type { SessionService } from "../services/SessionService";

function buildApp(service: Pick<SessionService, "listSessions" | "getSessionDetail" | "updateMetadata">) {
  const app = Fastify();
  registerSessionRoutes(app, service as SessionService);
  return app;
}

describe("session routes", () => {
  it("returns session detail", async () => {
    const app = buildApp({
      listSessions: async () => [],
      updateMetadata: async () => {
        throw new Error("not used");
      },
      getSessionDetail: async (sessionId: string) => ({
        id: sessionId,
        sessionId,
        title: "详情标题",
        defaultTitle: "详情标题",
        remarkTitle: null,
        summary: "摘要",
        workspace: "/workspace/app",
        createdAt: "2026-07-14T03:33:20.000Z",
        updatedAt: "2026-07-14T03:38:20.000Z",
        status: "history",
        cliVersion: "codex-cli 0.144.3",
        source: "cli",
        path: "/sessions/thread-1.jsonl",
        modelProvider: "openai",
        historyMode: "full",
        turns: []
      })
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions/thread-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session: {
        id: "thread-1",
        modelProvider: "openai",
        turns: []
      }
    });
  });

  it("returns 404 when session detail is missing", async () => {
    const app = buildApp({
      listSessions: async () => [],
      updateMetadata: async () => {
        throw new Error("not used");
      },
      getSessionDetail: async () => {
        throw new Error("Session not found");
      }
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: "SESSION_NOT_FOUND"
      }
    });
  });
});
