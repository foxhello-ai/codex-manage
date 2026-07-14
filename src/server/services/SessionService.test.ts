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
          limit: 20,
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
});
