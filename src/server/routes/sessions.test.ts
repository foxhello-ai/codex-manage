import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthHook } from "../auth/hooks";
import { registerSessionRoutes } from "./sessions";
import type { SessionService } from "../services/SessionService";
import type { JsonlSessionParser } from "../services/JsonlSessionParser";
import type { RuntimeManager } from "../services/RuntimeManager";
import type { SessionModelService } from "../services/SessionModelService";
import type { RuntimeSnapshot, SessionModelState } from "../../shared/models";

function emptyModelState(): SessionModelState {
  return {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    actualModel: null,
    actualModelProvider: null,
    actualReasoningEffort: null,
    actualModelSupported: null,
    applied: false,
    confirmationPending: false,
    updatedAt: null,
    lastError: null
  };
}

function runtimeSnapshot(threadId: string, patch: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    threadId,
    status: "history",
    permissionMode: "default",
    activeTurnId: null,
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    lastError: null,
    pendingApprovalCount: 0,
    eventSeq: 1,
    model: null,
    modelProvider: null,
    reasoningEffort: null,
    modelSelection: emptyModelState(),
    modelChangeStatus: "idle",
    modelChangeError: null,
    ...patch
  };
}

function buildApp(
  service: Pick<SessionService, "listSessions" | "getSessionDetail" | "updateMetadata">,
  parser?: Pick<JsonlSessionParser, "listCommands">,
  runtime?: Pick<RuntimeManager, "getRuntime" | "resumeThread" | "sendInput" | "submitApproval" | "eventHub" | "approvalService">,
  modelService?: Pick<SessionModelService, "updateSelection" | "resolveForResume" | "resolveForTurn">
) {
  const app = Fastify();
  registerSessionRoutes(
    app,
    service as SessionService,
    parser as JsonlSessionParser | undefined,
    runtime as RuntimeManager | undefined,
    modelService as SessionModelService | undefined
  );
  return app;
}

describe("session routes", () => {
  it("rejects unauthenticated model changes and WebSocket upgrades", async () => {
    const app = Fastify();
    await app.register(cookie, { secret: "test-secret-at-least-thirty-two-characters" });
    await app.register(websocket);
    registerAuthHook(app);
    registerSessionRoutes(
      app,
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); }
      } as unknown as SessionService,
      undefined,
      {
        getRuntime: (threadId: string) => runtimeSnapshot(threadId),
        eventHub: {
          getLastSeq: () => 0,
          getEvents: () => [],
          subscribe: () => () => undefined
        },
        approvalService: { listPending: () => [] }
      } as unknown as RuntimeManager,
      {
        updateSelection: async () => { throw new Error("must not be called"); }
      } as unknown as SessionModelService
    );
    await app.ready();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/sessions/thread-1/model",
      payload: { mode: "override", model: "frontier-v2" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    await expect(app.injectWS("/api/sessions/thread-1/ws")).rejects.toThrow(/401/);
  });

  it("returns session detail", async () => {
    let detailOptions: { includeTurns?: boolean } | undefined;
    const app = buildApp({
      listSessions: async () => [],
      updateMetadata: async () => {
        throw new Error("not used");
      },
      getSessionDetail: async (sessionId: string, options?: { includeTurns?: boolean }) => {
        detailOptions = options;
        return {
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
          modelState: { ...emptyModelState(), actualModelProvider: "openai" },
          turns: []
        };
      }
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions/thread-1?turns=false" });

    expect(response.statusCode).toBe(200);
    expect(detailOptions).toEqual({ includeTurns: false });
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
          return runtimeSnapshot(threadId, {
            status: "waiting_input",
            permissionMode: options.permissionMode ?? "default"
          });
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
          return runtimeSnapshot(threadId, {
            status: body.text === "继续" ? "running" : "failed",
            permissionMode: body.permissionMode ?? "default",
            activeTurnId: "turn-1"
          });
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

  it("submits one approval decision through the API", async () => {
    let submitted: { threadId: string; approvalId: string; body: unknown } | null = null;
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
        sendInput: (() => {
          throw new Error("not used");
        }) as any,
        submitApproval: ((threadId: string, approvalId: string, body: unknown) => {
          submitted = { threadId, approvalId, body };
          return {
            approval: { id: approvalId, threadId, status: "approved" },
            runtime: null
          };
        }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/thread-1/approvals/approval-1",
      payload: { decision: "accept", answers: { environment: ["生产"] } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ approval: { id: "approval-1", status: "approved" } });
    expect(submitted).toEqual({
      threadId: "thread-1",
      approvalId: "approval-1",
      body: { decision: "accept", answers: { environment: ["生产"] } }
    });
  });

  it("updates a session model through the domain service", async () => {
    const runtime = runtimeSnapshot("thread-1", {
      status: "waiting_input",
      model: "gpt-5.6-sol",
      modelSelection: {
        ...emptyModelState(),
        mode: "override",
        preferredModel: "gpt-5.6-sol",
        actualModel: "gpt-5.6-sol",
        applied: true
      },
      modelChangeStatus: "applied"
    });
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); }
      },
      undefined,
      {
        getRuntime: () => runtime,
        resumeThread: async () => runtime,
        sendInput: async () => runtime,
        submitApproval: (() => { throw new Error("not used"); }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      },
      {
        updateSelection: async (_sessionId, input) => ({
          selection: runtime.modelSelection,
          runtime,
          applied: input.mode === "override",
          confirmationPending: false
        }),
        resolveForResume: async () => ({ mode: "follow_session", model: null, reasoningEffort: null }),
        resolveForTurn: async () => ({ mode: "follow_session", model: null, reasoningEffort: null })
      }
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/sessions/thread-1/model",
      payload: { mode: "override", model: "gpt-5.6-sol", reasoningEffort: "high" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      applied: true,
      selection: { preferredModel: "gpt-5.6-sol" }
    });
  });

  it("maps model domain errors from the model endpoint", async () => {
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); }
      },
      undefined,
      undefined,
      {
        updateSelection: async () => {
          const { ModelDomainError } = await import("../modelErrors");
          throw new ModelDomainError("MODEL_SWITCH_NOT_ALLOWED", "当前会话状态不允许切换模型", 409);
        },
        resolveForResume: async () => ({ mode: "follow_session", model: null, reasoningEffort: null }),
        resolveForTurn: async () => ({ mode: "follow_session", model: null, reasoningEffort: null })
      }
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/sessions/thread-1/model",
      payload: { mode: "override", model: "gpt-5.6-sol" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "MODEL_SWITCH_NOT_ALLOWED" } });
  });

});
