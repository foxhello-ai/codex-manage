import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RuntimeManager } from "./RuntimeManager";

class FakeAppServer extends EventEmitter {
  requests: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: number; result: unknown }> = [];

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "thread/resume") return { thread: { id: (params as { threadId: string }).threadId } };
    return {};
  }

  respondToServerRequest(id: number, result: unknown) {
    this.responses.push({ id, result });
  }
}

describe("RuntimeManager", () => {
  it("does not resume the same active thread twice", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const first = await manager.resumeThread("thread-1");
    const second = await manager.resumeThread("thread-1");

    expect(first.status).toBe("waiting_input");
    expect(second.status).toBe("waiting_input");
    expect(appServer.requests.filter((request) => request.method === "thread/resume")).toHaveLength(1);
  });

  it("starts a turn when sending input", async () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);

    const runtime = await manager.sendInput("thread-1", { text: "继续" });

    expect(runtime.status).toBe("running");
    expect(appServer.requests.map((request) => request.method)).toEqual(["thread/resume", "turn/start"]);
    expect(appServer.requests[1].params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "继续", text_elements: [] }]
    });
  });

  it("publishes and resolves command approvals", () => {
    const appServer = new FakeAppServer();
    const manager = new RuntimeManager(appServer as any);
    const events: unknown[] = [];
    manager.eventHub.subscribe("thread-1", (event) => events.push(event));

    appServer.emit("serverRequest", {
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm test", cwd: "/repo", startedAtMs: 1 }
    });

    const pending = manager.approvalService.listPending("thread-1");
    expect(pending).toHaveLength(1);
    expect(manager.getRuntime("thread-1").status).toBe("waiting_approval");

    manager.submitApproval("thread-1", pending[0].id, { decision: "accept" });

    expect(appServer.responses).toEqual([{ id: 9, result: { decision: "accept" } }]);
    expect(manager.approvalService.listPending("thread-1")).toHaveLength(0);
    expect(events.some((event: any) => event.type === "approval_requested")).toBe(true);
    expect(events.some((event: any) => event.type === "approval_resolved")).toBe(true);
  });
});
