import { describe, expect, it } from "vitest";
import { SessionService } from "./SessionService";

function readyClient(response: unknown) {
  return {
    getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
    request: async <T = unknown>(_method: string, _params?: unknown) => response as T
  };
}

function metadataStore(entries: Record<string, { remarkTitle: string | null }> = {}) {
  return {
    getAll: async () => entries,
    update: async (sessionId: string, metadata: { remarkTitle: string | null }) => {
      entries[sessionId] = metadata;
      return metadata;
    }
  };
}

describe("SessionService", () => {
  it("does not wait for a desktop subscription for a Manage-owned runtime", async () => {
    let desktopReads = 0;
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready", pid: 1, lastError: null, initialized: true }),
      request: (async (method: string) => method === "thread/read"
        ? { thread: { id: "thread-1", historyMode: "paginated" } }
        : { data: [{ id: "manage-turn", items: [] }], nextCursor: null }) as any
    }, undefined, undefined, undefined, {
      getRuntime: () => ({ status: "running", executionSource: "manage", modelSelection: {} }) as any
    }, {
      readHistory: async () => { desktopReads++; return null; }
    });
    expect((await service.getSessionDetail("thread-1", { turnLimit: 20 })).turns[0].id).toBe("manage-turn");
    expect(desktopReads).toBe(0);
  });

  it("reads the desktop live page without a persisted-history RPC and keeps its real older-page cursor", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const liveTurn = { id: "live-turn", status: "inProgress", error: null, startedAt: "", completedAt: null, durationMs: null,
      items: [{ id: "live-message", type: "agent_message" as const, text: "正在执行中的输出", phase: "commentary" }] };
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready", pid: 1, lastError: null, initialized: true }),
      request: (async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "thread/read") return { thread: { id: "thread-1", historyMode: "paginated" } };
        if (params.cursor !== "native-older-cursor") throw new Error("must not request the initial persisted page");
        return { data: [{ id: "older-turn", items: [] }], nextCursor: null };
      }) as any
    }, undefined, undefined, undefined, undefined, {
      readHistory: async () => ({ turns: [liveTurn], nextCursor: "native-older-cursor", version: "desktop:owner:1" })
    });
    const initial = await service.getSessionDetail("thread-1", { turnLimit: 20 });
    expect(initial.turns).toEqual([liveTurn]);
    expect(initial.historyPage?.nextCursor).toBe("native-older-cursor");
    expect(calls.map(call => call.method)).toEqual(["thread/read"]);
    const unchanged = await service.getSessionDetail("thread-1", { turnLimit: 20, historyVersion: "desktop:owner:1" });
    expect(unchanged.turns).toEqual([]);
    expect(unchanged.historyPage?.unchanged).toBe(true);
    await service.getSessionDetail("thread-1", { turnLimit: 20, turnCursor: "native-older-cursor" });
    expect(calls.at(-1)).toMatchObject({ method: "thread/turns/list", params: { cursor: "native-older-cursor" } });
  });

  it("reads just the requested recent or older history page without loading all turns first", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready", pid: 1, lastError: null, initialized: true }),
      request: (async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "thread/read") return { thread: { id: "thread-1", historyMode: "paginated" } };
        return { data: [{ id: "newer", items: [] }, { id: "older", items: [] }], nextCursor: "page-before" };
      }) as any
    });
    const recent = await service.getSessionDetail("thread-1", { turnLimit: 20 });
    expect(recent.turns.map(turn => turn.id)).toEqual(["older", "newer"]);
    expect(recent.historyPage).toEqual({ nextCursor: "page-before", version: null, unchanged: false });
    expect(calls).toEqual([
      { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
      { method: "thread/turns/list", params: { threadId: "thread-1", cursor: null, limit: 20, sortDirection: "desc", itemsView: "full" } }
    ]);
    await service.getSessionDetail("thread-1", { turnLimit: 20, turnCursor: "page-before" });
    expect(calls.at(-1)?.params.cursor).toBe("page-before");
    expect(calls.map(call => call.method)).not.toContain("thread/resume");
  });

  it("reads all stored paginated turns without resuming and preserves client IDs for exact queue reconciliation", async () => {
    const calls: string[] = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready", pid: 1, lastError: null, initialized: true }),
      request: (async (method: string, params: any) => {
        calls.push(method);
        if (method === "thread/read") return { thread: { id: "thread-1", cwd: "/workspace", historyMode: "paginated", turns: [] } };
        return params.cursor ? { data: [{ id: "turn-2", items: [{ id: "item-2", type: "userMessage", clientId: "request-2", content: [{ type: "text", text: "same" }] }] }] }
          : { data: [{ id: "turn-1", items: [{ id: "item-1", type: "userMessage", clientId: "request-1", content: [{ type: "text", text: "same" }] }] }], nextCursor: "next" };
      }) as any
    });
    const detail = await service.getSessionDetail("thread-1");
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns.map(turn => turn.items[0])).toMatchObject([{ id: "item-1", clientId: "request-1" }, { id: "item-2", clientId: "request-2" }]);
    expect(calls).toEqual(["thread/read", "thread/turns/list", "thread/turns/list"]);
  });

  it("lists sessions from app-server thread/list", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
      request: async <T = unknown>(method: string, params?: unknown) => {
        calls.push({ method, params });
        return {
          data: [
            {
              id: "thread-1",
              sessionId: "session-1",
              preview: "请实现会话列表",
              name: null,
              cwd: "/workspace/app",
              createdAt: 1784000000,
              updatedAt: 1784000300,
              status: { type: "notLoaded" },
              cliVersion: "codex-cli 0.144.3",
              source: { type: "cli" }
            }
          ]
        } as T;
      }
    });

    const sessions = await service.listSessions({ search: "会话", limit: 20 });

    expect(calls).toEqual([
      {
        method: "thread/list",
          params: {
            cursor: null,
            limit: 100,
            sortDirection: "desc",
            sortKey: "updated_at",
            archived: false,
          searchTerm: null
        }
      }
    ]);
    expect(sessions).toEqual([
      {
        id: "thread-1",
        sessionId: "session-1",
        title: "请实现会话列表",
        defaultTitle: "请实现会话列表",
        remarkTitle: null,
        summary: "请实现会话列表",
        workspace: "/workspace/app",
        createdAt: "2026-07-14T03:33:20.000Z",
        updatedAt: "2026-07-14T03:38:20.000Z",
        status: "history",
        cliVersion: "codex-cli 0.144.3",
        source: "cli"
      }
    ]);
  });

  it("loads only one cursor page for the recent library", async () => {
    const calls: unknown[] = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
      request: async <T = unknown>(_method: string, params?: unknown) => {
        calls.push(params);
        const cursor = (params as { cursor: string | null }).cursor;
        return { data: [{ id: cursor ? "older" : "latest", preview: "title" }], nextCursor: cursor ? null : "page-2" } as T;
      }
    });
    await expect(service.listSessionPage()).resolves.toMatchObject({ sessions: [{ id: "latest" }], nextCursor: "page-2" });
    expect(calls).toHaveLength(1);
    await expect(service.listSessionPage({ cursor: "page-2" })).resolves.toMatchObject({ sessions: [{ id: "older" }], nextCursor: null });
    expect(calls).toMatchObject([{ limit: 30, cursor: null }, { limit: 30, cursor: "page-2" }]);
  });

  it("reads only task references and never scans unrelated sessions", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
      request: async <T = unknown>(method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method !== "thread/read") throw new Error("must not scan history");
        const id = (params as { threadId: string }).threadId;
        if (id === "deleted") throw new Error("Thread not found");
        return { thread: { id, preview: "task session" } } as T;
      }
    });
    await expect(service.getSessionSummaries(["older", "deleted", "older", "another"])).resolves.toMatchObject([{ id: "older" }, { id: "another" }]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.method === "thread/read" && (call.params as { includeTurns: boolean }).includeTurns === false)).toBe(true);
  });

  it("shares full scans, reuses search data, and reads current metadata", async () => {
    let calls = 0;
    const entries: Record<string, { remarkTitle: string | null }> = {};
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
      request: async <T = unknown>() => { calls++; return { data: [{ id: "one", preview: "original" }] } as T; }
    }, metadataStore(entries));
    await Promise.all([service.listSessions(), service.listSessions({ limit: 1000 })]);
    expect(calls).toBe(1);
    entries.one = { remarkTitle: "new title" };
    await expect(service.listSessions({ search: "new title" })).resolves.toMatchObject([{ id: "one", title: "new title" }]);
    expect(calls).toBe(1);
    service.invalidateList();
    await service.listSessions();
    expect(calls).toBe(2);
  });

  it("retries failed scans and does not reuse data after an app-server restart", async () => {
    let calls = 0;
    let pid = 1;
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid, lastError: null, initialized: true }),
      request: async <T = unknown>() => {
        if (++calls === 1) throw new Error("temporary failure");
        return { data: [{ id: `thread-${pid}`, preview: "title" }] } as T;
      }
    });
    await expect(service.listSessions()).rejects.toThrow("temporary failure");
    await expect(service.listSessions()).resolves.toMatchObject([{ id: "thread-1" }]);
    pid = 2;
    await expect(service.listSessions()).resolves.toMatchObject([{ id: "thread-2" }]);
    expect(calls).toBe(3);
  });

  it("deduplicates continuation records for the same logical session", async () => {
    const service = new SessionService(
      readyClient({
        data: [
          {
            id: "thread-1",
            sessionId: "session-1",
            name: "设计 fox-21 UI 及实现",
            preview: "旧的 rollout 记录",
            cwd: "/workspace/app",
            createdAt: 10,
            updatedAt: 20
          },
          {
            id: "thread-1",
            sessionId: "session-1",
            name: "设计 fox-21 UI 及实现",
            preview: "最新的 rollout 记录",
            cwd: "/workspace/app",
            createdAt: 10,
            updatedAt: 30
          }
        ]
      })
    );

    await expect(service.listSessions()).resolves.toMatchObject([
      {
        id: "thread-1",
        sessionId: "session-1",
        title: "设计 fox-21 UI 及实现",
        summary: "最新的 rollout 记录",
        updatedAt: "1970-01-01T00:00:30.000Z"
      }
    ]);
  });

  it("keeps forked threads with a shared sessionId as separate topics", async () => {
    const service = new SessionService(
      readyClient({
        data: [
          { id: "thread-1", sessionId: "session-1", preview: "同一话题", cwd: "/workspace/app", createdAt: 10, updatedAt: 20 },
          { id: "thread-2", sessionId: "session-1", preview: "同一话题", cwd: "/workspace/app", createdAt: 10, updatedAt: 30 }
        ]
      })
    );

    await expect(service.listSessions()).resolves.toMatchObject([
      { id: "thread-1", sessionId: "session-1" },
      { id: "thread-2", sessionId: "session-1" }
    ]);
  });

  it("paginates app-server sessions and searches beyond the first page", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
      request: async <T = unknown>(method: string, params?: unknown) => {
        calls.push({ method, params });
        if ((params as { cursor?: string | null }).cursor === "page-2") {
          return {
            data: [
              {
                id: "thread-2",
                sessionId: "session-2",
                preview: "second page target",
                cwd: "/workspace/target",
                createdAt: 1,
                updatedAt: 3
              }
            ],
            nextCursor: null
          } as T;
        }
        return {
          data: [
            {
              id: "thread-1",
              sessionId: "session-1",
              preview: "first page",
              cwd: "/workspace/first",
              createdAt: 1,
              updatedAt: 2
            }
          ],
          nextCursor: "page-2"
        } as T;
      }
    });

    await expect(service.listSessions({ search: "target" })).resolves.toMatchObject([
      {
        id: "thread-2",
        sessionId: "session-2",
        title: "second page target"
      }
    ]);
    expect(calls.map((call) => (call.params as { cursor?: string | null }).cursor)).toEqual([null, "page-2"]);
  });

  it("uses remark title as display title and searches it locally", async () => {
    const service = new SessionService(
      readyClient({
        data: [
          { id: "thread-1", sessionId: "session-1", preview: "default preview", cwd: "/a", createdAt: 1, updatedAt: 2 },
          { id: "thread-2", sessionId: "session-2", preview: "other preview", cwd: "/b", createdAt: 1, updatedAt: 3 }
        ]
      }),
      metadataStore({
        "thread-1": { remarkTitle: "移动端抽屉验收" }
      })
    );

    await expect(service.listSessions({ search: "抽屉" })).resolves.toMatchObject([
      { id: "thread-1", title: "移动端抽屉验收", defaultTitle: "default preview", remarkTitle: "移动端抽屉验收" }
    ]);
  });

  it("updates metadata and returns the refreshed session", async () => {
    const store = metadataStore();
    const service = new SessionService(
      readyClient({
        thread: { id: "thread-1", sessionId: "session-1", preview: "default preview", cwd: "/a", createdAt: 1, updatedAt: 2 }
      }),
      store
    );

    await expect(service.updateMetadata("thread-1", "备注标题")).resolves.toMatchObject({
      id: "thread-1",
      title: "备注标题",
      remarkTitle: "备注标题"
    });
  });

  it("stores and restores a session permission mode", async () => {
    let permissionMode: "default" | "full_access" = "default";
    const service = new SessionService(
      readyClient({ data: [] }),
      {
        getAll: async () => ({}),
        get: async () => ({
          remarkTitle: null,
          permissionMode,
          modelSelection: {
            mode: "follow_session" as const,
            preferredModel: null,
            preferredReasoningEffort: null,
            updatedAt: null
          }
        }),
        update: async () => ({ remarkTitle: null }),
        updatePermissionMode: async (_sessionId, nextMode) => {
          permissionMode = nextMode;
          return { permissionMode };
        }
      }
    );

    await expect(service.getPermissionMode("thread-1")).resolves.toBe("default");
    await service.updatePermissionMode("thread-1", "full_access");
    await expect(service.getPermissionMode("thread-1")).resolves.toBe("full_access");
  });


  it("reads session detail from app-server thread/read", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = new SessionService(
      {
        getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
        request: async <T = unknown>(method: string, params?: unknown) => {
          calls.push({ method, params });
          return {
            thread: {
              id: "thread-1",
              sessionId: "session-1",
              preview: "detail preview",
              cwd: "/workspace/app",
              path: "/sessions/thread-1.jsonl",
              createdAt: 1784000000,
              updatedAt: 1784000300,
              status: { type: "notLoaded" },
              cliVersion: "codex-cli 0.144.3",
              source: "cli",
              modelProvider: "openai",
              historyMode: "full",
              turns: [
                {
                  id: "turn-1",
                  status: "completed",
                  error: "upstream https://provider.example/v1/responses unavailable",
                  startedAt: 1784000000,
                  completedAt: 1784000010,
                  durationMs: 10000,
                  items: [
                    {
                      id: "item-user",
                      type: "userMessage",
                      content: [{ type: "text", text: "用户消息", text_elements: [] }]
                    },
                    { id: "item-agent", type: "agentMessage", text: "Codex 回复", phase: "final", memoryCitation: null },
                    {
                      id: "item-file",
                      type: "fileChange",
                      status: "completed",
                      changes: [{ path: "src/app.ts", kind: { type: "add" }, diff: "diff --git" }]
                    },
                    { id: "item-compact", type: "contextCompaction" },
                    { id: "item-new", type: "futureItem" }
                  ]
                }
              ]
            }
          } as T;
        }
      },
      metadataStore({ "thread-1": { remarkTitle: "详情备注" } })
    );

    const detail = await service.getSessionDetail("thread-1");

    expect(calls).toEqual([
      {
        method: "thread/read",
        params: {
          threadId: "thread-1",
          includeTurns: true
        }
      }
    ]);
    expect(detail).toMatchObject({
      id: "thread-1",
      title: "详情备注",
      modelProvider: "openai",
      historyMode: "full",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: "upstream [REDACTED_URL] unavailable",
          items: [
            { id: "item-user", type: "user_message", text: "用户消息" },
            { id: "item-agent", type: "agent_message", text: "Codex 回复", phase: "final" },
            { id: "item-file", type: "file_change", changes: [{ path: "src/app.ts", kind: "add", diff: "diff --git" }] },
            { id: "item-compact", type: "context_compaction" },
            { id: "item-new", type: "unknown", rawType: "futureItem" }
          ]
        }
      ]
    });
  });

  it("can read lightweight session detail without turns", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const service = new SessionService({
      getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
      request: async <T = unknown>(method: string, params?: unknown) => {
        calls.push({ method, params });
        return {
          thread: {
            id: "thread-1",
            preview: "lightweight detail",
            cwd: "/workspace/app",
            createdAt: 1,
            updatedAt: 2
          }
        } as T;
      }
    });

    await service.getSessionDetail("thread-1", { includeTurns: false });

    expect(calls).toEqual([{
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: false }
    }]);
  });

  it("accepts sessionId-only app-server records", async () => {
    const service = new SessionService(
      readyClient({
        data: [{ sessionId: "session-only-1", preview: "session only", cwd: "/a", createdAt: 1, updatedAt: 2 }]
      }),
      metadataStore({
        "session-only-1": { remarkTitle: "兼容标题" }
      })
    );

    await expect(service.listSessions()).resolves.toMatchObject([
      {
        id: "session-only-1",
        sessionId: "session-only-1",
        title: "兼容标题"
      }
    ]);
  });

  it("maps active and failed statuses", async () => {
    const service = new SessionService(
      readyClient({
        data: [
          { id: "a", preview: "A", cwd: "/a", createdAt: 1, updatedAt: 2, status: { type: "running" } },
          { id: "b", preview: "B", cwd: "/b", createdAt: 1, updatedAt: 2, status: { type: "failed" } }
        ]
      })
    );

    await expect(service.listSessions()).resolves.toMatchObject([{ status: "running" }, { status: "failed" }]);
  });

  it("fails clearly when app-server is not ready", async () => {
    const service = new SessionService({
      getSnapshot: () => ({ status: "failed" as const, pid: null, lastError: "boom", initialized: false }),
      request: async <T = unknown>() => ({ data: [] }) as T
    });

    await expect(service.listSessions()).rejects.toThrow("Codex app-server is not ready");
  });
  it("combines persisted preference with unsupported historical model state", async () => {
    const service = new SessionService(
      readyClient({
        thread: {
          id: "thread-1",
          sessionId: "thread-1",
          preview: "model state",
          cwd: "/workspace/app",
          createdAt: 1,
          updatedAt: 2,
          modelProvider: "thread-provider",
          turns: []
        }
      }),
      {
        getAll: async () => ({ "thread-1": { remarkTitle: null } }),
        get: async () => ({
          remarkTitle: null,
          modelSelection: {
            mode: "override" as const,
            preferredModel: "gpt-5.6-sol",
            preferredReasoningEffort: "high",
            updatedAt: "2026-07-19T00:00:00.000Z"
          }
        }),
        update: async (_sessionId, metadata) => metadata
      },
      {
        readModelState: async () => ({
          state: {
            model: "z-ai/glm-5.2",
            modelProvider: "custom",
            reasoningEffort: "medium",
            updatedAt: "2026-07-19T00:01:00.000Z"
          },
          diagnostics: { scannedFiles: 1, parsedLines: 3, parseErrors: 0, matchedSessionFile: true }
        })
      },
      {
        isModelSupportedFromCache: () => false
      }
    );

    await expect(service.getSessionDetail("thread-1")).resolves.toMatchObject({
      modelState: {
        mode: "override",
        preferredModel: "gpt-5.6-sol",
        actualModel: "z-ai/glm-5.2",
        actualModelProvider: "custom",
        actualReasoningEffort: "medium",
        actualModelSupported: false,
        applied: false
      }
    });
  });

  it("prefers active runtime model state over historical JSONL", async () => {
    const service = new SessionService(
      readyClient({
        thread: {
          id: "thread-1",
          preview: "runtime model",
          cwd: "/workspace/app",
          createdAt: 1,
          updatedAt: 2,
          turns: []
        }
      }),
      undefined,
      {
        readModelState: async () => ({
          state: { model: "old-model", modelProvider: "old-provider", reasoningEffort: "low", updatedAt: null },
          diagnostics: { scannedFiles: 1, parsedLines: 2, parseErrors: 0, matchedSessionFile: true }
        })
      },
      {
        isModelSupportedFromCache: () => true
      },
      {
        getRuntime: () => ({
          threadId: "thread-1",
          status: "waiting_input" as const,
          permissionMode: "default" as const,
          activeTurnId: null,
          startedAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
          lastError: null,
          pendingApprovalCount: 0,
          eventSeq: 0,
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          reasoningEffort: "high",
          modelSelection: {
            mode: "override" as const,
            preferredModel: "gpt-5.6-sol",
            preferredReasoningEffort: "high",
            actualModel: "gpt-5.6-sol",
            actualModelProvider: "openai",
            actualReasoningEffort: "high",
            actualModelSupported: true,
            applied: true,
            confirmationPending: false,
            updatedAt: "2026-07-19T00:00:00.000Z",
            lastError: null
          },
          modelChangeStatus: "applied" as const,
          modelChangeError: null
        })
      }
    );

    await expect(service.getSessionDetail("thread-1")).resolves.toMatchObject({
      modelState: {
        actualModel: "gpt-5.6-sol",
        actualModelProvider: "openai",
        actualReasoningEffort: "high",
        actualModelSupported: true,
        applied: true
      }
    });
  });

});
