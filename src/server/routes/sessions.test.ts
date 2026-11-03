import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerAuthHook } from "../auth/hooks";
import { registerAuthRoutes } from "./auth";
import { registerSessionRoutes } from "./sessions";
import { CollaborationStore } from "../services/CollaborationStore";
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
  service: Pick<SessionService, "listSessions" | "getSessionDetail" | "updateMetadata">
    & Partial<Pick<SessionService, "getPermissionMode" | "updatePermissionMode">>,
  parser?: Pick<JsonlSessionParser, "listCommands">,
  runtime?: Pick<RuntimeManager, "getRuntime" | "resumeThread" | "sendInput" | "submitApproval" | "eventHub" | "approvalService">
    & Partial<Pick<RuntimeManager, "branchThread" | "hydratePermissionMode" | "startThread" | "startHistoryContinuation">>,
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
  it("lets the owner explicitly follow desktop settings without applying stored Manage overrides", async () => {
    let submitted: any;
    let resolutions = 0;
    const runtime = runtimeSnapshot("thread-1", { executionSource: "external_queue" });
    const app = buildApp({
      listSessions: async () => [], getSessionDetail: async () => ({}) as any,
      updateMetadata: async () => ({}) as any, getPermissionMode: async () => "full_access"
    }, undefined, {
      getRuntime: () => runtime,
      sendInput: async (_id: string, body: any) => { submitted = body; return runtime; }
    } as any, {
      resolveForTurn: async () => { resolutions++; throw Error("must not resolve"); }
    } as any);
    const sent = await app.inject({ method: "POST", url: "/api/sessions/thread-1/input", payload: { text: "follow desktop", useDesktopSettings: true } });
    expect(sent.statusCode).toBe(202);
    expect(submitted).toMatchObject({ allowExternalQueue: true });
    expect(submitted.permissionMode).toBeUndefined();
    expect(submitted.modelOverride).toBeUndefined();
    expect(resolutions).toBe(0);
    const invalid = await app.inject({ method: "POST", url: "/api/sessions/thread-1/input", payload: { text: "follow desktop", useDesktopSettings: true, permissionMode: "full_access" } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("reads runtime without acquiring a writer and returns queued input as accepted rather than completed", async () => {
    let resumes = 0;
    let submitted: any;
    const runtime = runtimeSnapshot("thread-1", { status: "history" });
    const app = buildApp({ listSessions: async () => [], getSessionDetail: async () => ({}) as any, updateMetadata: async () => ({}) as any }, undefined, {
      getRuntime: () => runtime,
      hydratePermissionMode: () => runtime,
      resumeThread: async () => { resumes++; return runtime; },
      sendInput: async (_id: string, body: any) => { submitted = body; return { ...runtime, executionSource: "external_queue", deliveries: [{ status: "queued" }] }; }
    } as any);
    const read = await app.inject({ method: "GET", url: "/api/sessions/thread-1/runtime" });
    expect(read.statusCode).toBe(200);
    expect(resumes).toBe(0);
    const sent = await app.inject({ method: "POST", url: "/api/sessions/thread-1/input", payload: { text: "follow up", clientRequestId: "request-1" } });
    expect(sent.statusCode).toBe(202);
    expect(submitted).toMatchObject({ clientRequestId: "request-1", allowExternalQueue: true });
    expect(sent.json().runtime.deliveries[0].status).toBe("queued");
    await app.close();
  });

  it("creates a new session with the requested workspace", async () => {
    let requestedCwd: string | undefined;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); }
      },
      undefined,
      {
        startThread: async (cwd: string) => {
          requestedCwd = cwd;
          return { threadId: "thread-new", runtime: runtimeSnapshot("thread-new", { status: "waiting_input" }) };
        }
      } as unknown as RuntimeManager
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd: " /workspace/app " }
    });

    expect(response.statusCode).toBe(201);
    expect(requestedCwd).toBe("/workspace/app");
    expect(response.json()).toMatchObject({ threadId: "thread-new", runtime: { threadId: "thread-new" } });
  });

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

  it("subscribes before the initial snapshot so an approval cannot be missed", async () => {
    const app = Fastify();
    await app.register(websocket);
    let lastSeq = 0;
    const callOrder: string[] = [];
    registerSessionRoutes(
      app,
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); }
      } as unknown as SessionService,
      undefined,
      {
        getRuntime: () => {
          callOrder.push("getRuntime");
          return runtimeSnapshot("thread-1", { status: "waiting_approval", pendingApprovalCount: 1, eventSeq: lastSeq });
        },
        eventHub: {
          getLastSeq: () => {
            callOrder.push("getLastSeq");
            return lastSeq;
          },
          getEvents: () => [],
          subscribe: (_threadId: string, subscriber: (event: unknown) => void) => {
            callOrder.push("subscribe");
            lastSeq = 1;
            void subscriber;
            return () => undefined;
          }
        },
        approvalService: {
          listPending: () => {
            callOrder.push("listPending");
            return [];
          }
        }
      } as unknown as RuntimeManager
    );
    await app.ready();

    const socket = await app.injectWS("/api/sessions/thread-1/ws");
    socket.terminate();

    expect(callOrder).toEqual(["subscribe", "getLastSeq", "getRuntime", "listPending"]);
  });

  it("filters child session access on list and detail routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-session-acl-"));
    try {
      const store = new CollaborationStore(join(directory, "collaboration.json"));
      const child = await store.createChild({
        displayName: "Alex",
        localEmail: "alex@local",
        password: "secret-pass"
      });
      await store.replaceGrants(child.collaborator.id, ["session-a"]);

      const app = Fastify();
      const config = {
        host: "0.0.0.0",
        port: 3000,
        password: "admin",
        defaultPassword: false,
        ownerName: "Jamie Chen",
        ownerEmail: "jamie@local",
        sessionSecret: "test-secret-at-least-thirty-two-characters",
        codexCliPath: "codex",
        sessionsDir: "/tmp/sessions",
        metadataFile: "/tmp/session-metadata.json",
        clientDir: "/tmp/client"
      };
      await app.register(cookie, { secret: config.sessionSecret });
      registerAuthHook(app, store);
      registerAuthRoutes(app, config, store);
      registerSessionRoutes(
        app,
        {
          listSessions: async () => [
            { id: "session-a", sessionId: "thread-a" },
            { id: "session-b", sessionId: "thread-b" }
          ] as never,
          getSessionDetail: async (sessionId: string) => ({ id: sessionId }) as never,
          updateMetadata: async () => ({}) as never
        } as unknown as SessionService,
        undefined,
        undefined,
        undefined,
        store
      );
      await app.ready();

      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { accountId: child.collaborator.id, password: "secret-pass" }
      });
      const cookieHeader = login.headers["set-cookie"];
      const sessionCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;

      const list = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: sessionCookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ sessions: [{ id: "session-a", sessionId: "thread-a" }] });

      const denied = await app.inject({ method: "GET", url: "/api/sessions/session-b", headers: { cookie: sessionCookie } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: "SESSION_ACCESS_DENIED" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("downloads workspace files with their original bytes and blocks paths outside the workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-file-download-"));
    const workspace = join(directory, "workspace");
    const filePath = join(workspace, "sample.exe");
    const outsidePath = join(directory, "outside.exe");
    const bytes = Buffer.from([0, 1, 2, 255, 254, 253]);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(filePath, bytes, { encoding: null });
      await writeFile(outsidePath, bytes, { encoding: null });
      const app = Fastify();
      const config = {
        host: "0.0.0.0",
        port: 3000,
        password: "admin",
        defaultPassword: false,
        ownerName: "Jamie Chen",
        ownerEmail: "jamie@local",
        sessionSecret: "test-secret-at-least-thirty-two-characters",
        codexCliPath: "codex",
        sessionsDir: "/tmp/sessions",
        metadataFile: "/tmp/session-metadata.json",
        clientDir: "/tmp/client"
      };
      await app.register(cookie, { secret: config.sessionSecret });
      registerAuthHook(app);
      registerAuthRoutes(app, config);
      registerSessionRoutes(
        app,
        {
          listSessions: async () => [],
          getSessionDetail: async () => ({ workspace }) as never,
          updateMetadata: async () => { throw new Error("not used"); }
        } as unknown as SessionService
      );
      await app.ready();

      const unauthenticated = await app.inject({
        method: "GET",
        url: `/api/sessions/session-a/files?path=${encodeURIComponent(filePath)}`
      });
      expect(unauthenticated.statusCode).toBe(401);

      const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "admin" } });
      const cookieHeader = login.headers["set-cookie"];
      const sessionCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
      const downloaded = await app.inject({
        method: "GET",
        url: `/api/sessions/session-a/files?path=${encodeURIComponent(filePath)}`,
        headers: { cookie: sessionCookie }
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.headers["content-type"]).toContain("application/vnd.microsoft.portable-executable");
      expect(downloaded.headers["content-length"]).toBe(String(bytes.length));
      expect(downloaded.headers["content-disposition"]).toContain("sample.exe");
      expect(downloaded.rawPayload).toEqual(bytes);

      const outside = await app.inject({
        method: "GET",
        url: `/api/sessions/session-a/files?path=${encodeURIComponent(outsidePath)}`,
        headers: { cookie: sessionCookie }
      });
      expect(outside.statusCode).toBe(403);
      expect(outside.json()).toMatchObject({ error: { code: "FILE_OUTSIDE_WORKSPACE" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("downgrades an existing full-access session before child input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-controlled-runtime-"));
    try {
      const store = new CollaborationStore(join(directory, "collaboration.json"));
      const child = await store.createChild({
        displayName: "Alex",
        localEmail: "alex@local",
        password: "secret-pass"
      });
      await store.replaceGrants(child.collaborator.id, ["session-a"]);

      let resumeOptions: { permissionMode?: "default" | "full_access" } | undefined;
      let inputOptions: { permissionMode?: "default" | "full_access" } | undefined;
      const app = Fastify();
      const config = {
        host: "0.0.0.0",
        port: 3000,
        password: "admin",
        defaultPassword: false,
        ownerName: "Jamie Chen",
        ownerEmail: "jamie@local",
        sessionSecret: "test-secret-at-least-thirty-two-characters",
        codexCliPath: "codex",
        sessionsDir: "/tmp/sessions",
        metadataFile: "/tmp/session-metadata.json",
        clientDir: "/tmp/client"
      };
      await app.register(cookie, { secret: config.sessionSecret });
      registerAuthHook(app, store);
      registerAuthRoutes(app, config, store);
      registerSessionRoutes(
        app,
        {
          listSessions: async () => [],
          getSessionDetail: async () => { throw new Error("not used"); },
          updateMetadata: async () => { throw new Error("not used"); }
        } as unknown as SessionService,
        undefined,
        {
          getRuntime: () => runtimeSnapshot("session-a", { status: "waiting_input", permissionMode: "full_access" }),
          resumeThread: async (threadId: string, options: { permissionMode?: "default" | "full_access" }) => {
            resumeOptions = options;
            return runtimeSnapshot(threadId, { status: "waiting_input", permissionMode: options.permissionMode ?? "default" });
          },
          sendInput: async (threadId: string, options: { permissionMode?: "default" | "full_access" }) => {
            inputOptions = options;
            return runtimeSnapshot(threadId, { status: "running", permissionMode: options.permissionMode ?? "default" });
          },
          submitApproval: () => { throw new Error("not used"); },
          eventHub: {} as any,
          approvalService: {} as any
        } as unknown as RuntimeManager,
        undefined,
        store
      );
      await app.ready();

      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { accountId: child.collaborator.id, password: "secret-pass" }
      });
      const cookieHeader = login.headers["set-cookie"];
      const sessionCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/session-a/input",
        headers: { cookie: sessionCookie },
        payload: { text: "继续", permissionMode: "default" }
      });

      expect(response.statusCode).toBe(200);
      expect(resumeOptions).toEqual({ permissionMode: "default" });
      expect(inputOptions).toMatchObject({ text: "继续", permissionMode: "default", allowExternalQueue: false, clientRequestId: expect.any(String) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    let persistedPermissionMode: "default" | "full_access" | undefined;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => {
          throw new Error("not used");
        },
        getSessionDetail: async () => {
          throw new Error("not used");
        },
        updatePermissionMode: async (_sessionId, permissionMode) => {
          persistedPermissionMode = permissionMode;
        }
      },
      undefined,
      {
        getRuntime: () => runtimeSnapshot("thread-1"),
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
    expect(persistedPermissionMode).toBe("full_access");
  });

  it("restores the persisted permission mode after the runtime is recreated", async () => {
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); },
        getPermissionMode: async () => "full_access"
      },
      undefined,
      {
        getRuntime: () => runtimeSnapshot("thread-1"),
        hydratePermissionMode: (threadId, permissionMode) => runtimeSnapshot(threadId, { permissionMode }),
        resumeThread: async () => { throw new Error("not used"); },
        sendInput: async () => { throw new Error("not used"); },
        submitApproval: (() => { throw new Error("not used"); }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({ method: "GET", url: "/api/sessions/thread-1/runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runtime: { permissionMode: "full_access" } });
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
        getRuntime: () => runtimeSnapshot("thread-1"),
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
    expect(submittedBody).toMatchObject({ text: "继续", permissionMode: "full_access", allowExternalQueue: true, clientRequestId: expect.any(String) });
  });

  it("uses the persisted permission mode when the refreshed browser sends a stale default", async () => {
    let submittedBody: { text: string; permissionMode?: "default" | "full_access" } | undefined;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); },
        getPermissionMode: async () => "full_access"
      },
      undefined,
      {
        getRuntime: () => runtimeSnapshot("thread-1"),
        resumeThread: async () => { throw new Error("not used"); },
        sendInput: async (threadId, body) => {
          submittedBody = body;
          return runtimeSnapshot(threadId, { status: "running", permissionMode: body.permissionMode ?? "default", activeTurnId: "turn-1" });
        },
        submitApproval: (() => { throw new Error("not used"); }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/thread-1/input",
      payload: { text: "继续", permissionMode: "default" }
    });

    expect(response.statusCode).toBe(200);
    expect(submittedBody).toMatchObject({ text: "继续", permissionMode: "full_access", allowExternalQueue: true, clientRequestId: expect.any(String) });
  });

  it("maps an active writer error to a clear session conflict", async () => {
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        getSessionDetail: async () => { throw new Error("not used"); }
      },
      undefined,
      {
        getRuntime: () => runtimeSnapshot("thread-1"),
        resumeThread: (() => { throw new Error("not used"); }) as any,
        sendInput: async () => { throw new Error("thread already has an active writer"); },
        submitApproval: (() => { throw new Error("not used"); }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/thread-1/input",
      payload: { text: "继续" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "SESSION_ACTIVE_WRITER",
        message: "此会话由其他客户端持有写入权，当前操作无法继续。文字续聊可通过兼容版本的原生队列投递；请保留输入，勿重复发送"
      }
    });
  });

  it.each([
    ["full_fork", "原会话 · Fork（保留全部历史）"],
    ["compact_new_topic", "原会话 · 压缩后新话题"]
  ] as const)("creates a %s session branch with a distinguishable title", async (mode, expectedTitle) => {
    let updatedMetadata: { sessionId: string; remarkTitle: string | null } | null = null;
    let persistedPermissionMode: "default" | "full_access" | null = null;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async (sessionId, remarkTitle) => {
          updatedMetadata = { sessionId, remarkTitle };
          return { id: sessionId, title: remarkTitle } as any;
        },
        updatePermissionMode: async (_sessionId, permissionMode) => {
          persistedPermissionMode = permissionMode;
        },
        getSessionDetail: async (sessionId) => ({
          id: sessionId,
          title: sessionId === "thread-1" ? "原会话" : expectedTitle
        } as any)
      },
      undefined,
      {
        getRuntime: () => runtimeSnapshot("thread-1"),
        resumeThread: async () => runtimeSnapshot("thread-2", { status: "waiting_input" }),
        sendInput: async () => runtimeSnapshot("thread-1"),
        branchThread: async (threadId, mode) => ({
          threadId: "thread-2",
          runtime: runtimeSnapshot("thread-2", { status: "waiting_input" })
        }),
        submitApproval: (() => { throw new Error("not used"); }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/thread-1/branch",
      payload: { mode }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      mode,
      session: { id: "thread-2", title: expectedTitle },
      runtime: { threadId: "thread-2" }
    });
    expect(updatedMetadata).toEqual({ sessionId: "thread-2", remarkTitle: expectedTitle });
    expect(persistedPermissionMode).toBe("default");
  });

  it("creates an independent history continuation and keeps the failed input in the response", async () => {
    let started: { cwd: string; sourceThreadId: string; text: string; permissionMode?: string } | null = null;
    let titled: { sessionId: string; title: string | null } | null = null;
    const app = buildApp(
      {
        listSessions: async () => [],
        updateMetadata: async () => { throw new Error("not used"); },
        setRemarkTitle: async (sessionId: string, title: string | null) => {
          titled = { sessionId, title };
        },
        getSessionDetail: async () => { throw new Error("source thread must not be read"); }
      } as unknown as SessionService,
      undefined,
      {
        getRuntime: () => runtimeSnapshot("thread-1"),
        startHistoryContinuation: async (
          cwd: string,
          sourceThreadId: string,
          text: string,
          options: { permissionMode?: "default" | "full_access" }
        ) => {
          started = { cwd, sourceThreadId, text, permissionMode: options.permissionMode };
          return {
            threadId: "thread-history-new",
            runtime: runtimeSnapshot("thread-history-new", {
              status: "failed",
              permissionMode: "full_access",
              lastError: "模型请求失败"
            }),
            inputError: "模型请求失败"
          };
        },
        resumeThread: (() => { throw new Error("not used"); }) as any,
        sendInput: (() => { throw new Error("not used"); }) as any,
        submitApproval: (() => { throw new Error("not used"); }) as any,
        eventHub: {} as any,
        approvalService: {} as any
      } as unknown as RuntimeManager
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/thread-locked/continue-from-history",
      payload: {
        cwd: "/workspace/app",
        sourceTitle: "原会话",
        text: "重新处理失败输入",
        permissionMode: "full_access"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(started).toEqual({
      cwd: "/workspace/app",
      sourceThreadId: "thread-locked",
      text: "重新处理失败输入",
      permissionMode: "full_access"
    });
    expect(titled).toEqual({ sessionId: "thread-history-new", title: "原会话 · 历史续聊（新会话）" });
    expect(response.json()).toMatchObject({
      sourceSessionId: "thread-locked",
      inputError: "模型请求失败",
      metadataError: null,
      session: {
        id: "thread-history-new",
        title: "原会话 · 历史续聊（新会话）",
        workspace: "/workspace/app"
      },
      runtime: { threadId: "thread-history-new", permissionMode: "full_access" }
    });
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
