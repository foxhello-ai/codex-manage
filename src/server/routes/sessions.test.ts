import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSessionRoutes } from "./sessions";
import type { SessionService } from "../services/SessionService";
import type { JsonlSessionParser } from "../services/JsonlSessionParser";
import type { RuntimeManager } from "../services/RuntimeManager";

function buildApp(
  service: Pick<SessionService, "listSessions" | "getSessionDetail" | "updateMetadata">,
  parser?: Pick<JsonlSessionParser, "listCommands">,
  runtime?: Pick<RuntimeManager, "getRuntime" | "resumeThread" | "sendInput" | "submitApproval" | "eventHub" | "approvalService">
) {
  const app = Fastify();
  registerSessionRoutes(app, service as SessionService, parser as JsonlSessionParser | undefined, runtime as RuntimeManager | undefined);
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

  it("returns session commands", async () => {
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => {
          throw new Error("not used");
        },
        getSessionDetail: async () => {
          throw new Error("not used");
        }
      },
      {
        listCommands: async (sessionId: string) => ({
          commands: [
            {
              id: "call-1",
              callId: "call-1",
              turnId: "turn-1",
              timestamp: "2026-07-14T00:00:01Z",
              status: "completed",
              cmd: "npm test",
              workdir: "/workspace/app",
              sandboxPermissions: null,
              justification: null,
              prefixRule: null,
              tty: null,
              yieldTimeMs: 30000,
              maxOutputTokens: 12000,
              output: "passed",
              outputLength: 6
            }
          ],
          diagnostics: { scannedFiles: 1, parsedLines: 4, parseErrors: 0, matchedSessionFile: sessionId === "thread-1" }
        })
      }
    );

    const response = await app.inject({ method: "GET", url: "/api/sessions/thread-1/commands" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      commands: [{ callId: "call-1", cmd: "npm test", output: "passed" }],
      diagnostics: { matchedSessionFile: true }
    });
  });


  it("resumes a session", async () => {
    let resumedOptions: { permissionMode?: "default" | "full_access" } | undefined;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => {
          throw new Error("not used");
        },
        getSessionDetail: async () => {
          throw new Error("not used");
        }
      },
      undefined,
      {
        getRuntime: (() => {
          throw new Error("not used");
        }) as any,
        resumeThread: async (threadId: string, options: { permissionMode?: "default" | "full_access" } = {}) => {
          resumedOptions = options;
          return {
            threadId,
            status: "waiting_input",
            permissionMode: options.permissionMode ?? "default",
            activeTurnId: null,
            startedAt: "2026-07-14T00:00:00.000Z",
            updatedAt: "2026-07-14T00:00:00.000Z",
            lastError: null,
            pendingApprovalCount: 0,
            eventSeq: 1
          };
        },
        sendInput: (() => {
          throw new Error("not used");
        }) as any,
        submitApproval: (() => {
          throw new Error("not used");
        }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({ method: "POST", url: "/api/sessions/thread-1/resume", payload: { permissionMode: "full_access" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runtime: { threadId: "thread-1", status: "waiting_input" } });
    expect(resumedOptions).toEqual({ permissionMode: "full_access" });
  });

  it("rejects an invalid permission mode", async () => {
    const app = buildApp({
      listSessions: async () => [],
      updateMetadata: async () => {
        throw new Error("not used");
      },
      getSessionDetail: async () => {
        throw new Error("not used");
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/thread-1/resume",
      payload: { permissionMode: "invalid" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_PERMISSION_MODE" } });
  });


  it("submits input", async () => {
    let submittedBody: { text: string; permissionMode?: "default" | "full_access" } | undefined;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => {
          throw new Error("not used");
        },
        getSessionDetail: async () => {
          throw new Error("not used");
        }
      },
      undefined,
      {
        getRuntime: (() => {
          throw new Error("not used");
        }) as any,
        resumeThread: (() => {
          throw new Error("not used");
        }) as any,
        sendInput: async (threadId: string, body: { text: string; permissionMode?: "default" | "full_access" }) => {
          submittedBody = body;
          return {
            threadId,
            status: body.text === "继续" ? "running" : "failed",
            permissionMode: body.permissionMode ?? "default",
            activeTurnId: "turn-1",
            startedAt: "2026-07-14T00:00:00.000Z",
            updatedAt: "2026-07-14T00:00:00.000Z",
            lastError: null,
            pendingApprovalCount: 0,
            eventSeq: 1
          };
        },
        submitApproval: (() => {
          throw new Error("not used");
        }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({ method: "POST", url: "/api/sessions/thread-1/input", payload: { text: "继续", permissionMode: "full_access" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runtime: { threadId: "thread-1", status: "running" } });
    expect(submittedBody).toEqual({ text: "继续", permissionMode: "full_access" });
  });

});
