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
        data: [{ id: "thread-1", sessionId: "session-1", preview: "default preview", cwd: "/a", createdAt: 1, updatedAt: 2 }]
      }),
      store
    );

    await expect(service.updateMetadata("thread-1", "备注标题")).resolves.toMatchObject({
      id: "thread-1",
      title: "备注标题",
      remarkTitle: "备注标题"
    });
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
        list: async () => ({
          models: [{
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: null,
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
            upgradeModel: null,
            upgradeCopy: null
          }],
          loadedAt: "2026-07-19T00:00:00.000Z",
          stale: false,
          lastError: null
        })
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
        list: async () => ({
          models: [{
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: null,
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
            upgradeModel: null,
            upgradeCopy: null
          }],
          loadedAt: "2026-07-19T00:00:00.000Z",
          stale: false,
          lastError: null
        })
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
