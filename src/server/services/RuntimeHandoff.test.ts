import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./RuntimeManager";
import { DesktopQueueService } from "./DesktopQueueService";

class Server extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  loaded = new Set<string>();
  background = false;
  external = false;
  deferUnload = false;
  turnError = false;
  async request(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    const id = params.threadId;
    if (method === "thread/start") { this.loaded.add("new-thread"); return { thread: { id: "new-thread" } }; }
    if (method === "thread/resume") {
      if (this.external) throw Error("thread already has an active writer");
      this.loaded.add(id); return { thread: { id, status: { type: "idle" } } };
    }
    if (method === "thread/read") return { thread: { id, status: { type: "idle" } } };
    if (method === "thread/backgroundTerminals/list") return { data: this.background ? [{ processId: "task-1" }] : [] };
    if (method === "thread/list") return { data: [] };
    if (method === "thread/loaded/list") return { data: [...this.loaded] };
    if (method === "thread/unsubscribe") { if (!this.deferUnload) this.loaded.delete(id); return { status: "unsubscribed" }; }
    if (method === "turn/start") { if (this.turnError) throw Error("turn/start timeout"); return { turn: { id: "turn-1" } }; }
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-1", clientUserMessageId: params.clientUserMessageId } };
    return {};
  }
}
const managers: RuntimeManager[] = [], directories: string[] = [];
afterEach(async () => { managers.splice(0).forEach(manager => manager.dispose()); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function manager(server: Server, options = {}) {
  const runtime = new RuntimeManager(server as any, { autoRelease: true, releaseIdleDelayMs: 5, ...options }); managers.push(runtime); return runtime;
}
async function queue(server: Server) { const dir = await mkdtemp(join(tmpdir(), "manage-handoff-")); directories.push(dir); return new DesktopQueueService(server, join(dir, "queue.json")); }

describe("runtime writer handoff", () => {
  it("keeps a new unmaterialized thread loaded until its first turn completes", async () => {
    const server = new Server(), runtime = manager(server);
    const started = await runtime.startThread("/workspace");
    await vi.waitFor(() => expect(runtime.getRuntime(started.threadId).leaseStatus).toBe("blocked"));
    expect(server.calls.some(row => row.method === "thread/unsubscribe")).toBe(false);
    await runtime.sendInput(started.threadId, { text: "first message" });
    expect(server.calls.some(row => row.method === "thread/resume")).toBe(false);
    server.emit("notification", { method: "turn/completed", params: { threadId: started.threadId, turn: { id: "turn-1" } } });
    await vi.waitFor(() => expect(runtime.getRuntime(started.threadId).leaseStatus).toBe("released"));
  });

  it("unloads an idle thread without stopping the backend or another loaded thread", async () => {
    const server = new Server(), runtime = manager(server);
    server.loaded.add("other-thread");
    await runtime.resumeThread("thread-1");
    await vi.waitFor(() => expect(runtime.getRuntime("thread-1").leaseStatus).toBe("released"));
    expect(server.loaded.has("other-thread")).toBe(true);
    expect(runtime.getRuntime("thread-1").status).toBe("history");
    await runtime.sendInput("thread-1", { text: "continue" });
    expect(server.calls.filter(row => row.method === "thread/resume")).toHaveLength(2);
    expect(runtime.getRuntime("thread-1").status).toBe("running");
  });

  it("blocks release while a background task exists, and never releases a running turn", async () => {
    const server = new Server(), runtime = manager(server); server.background = true;
    await runtime.resumeThread("thread-1");
    await vi.waitFor(() => expect(runtime.getRuntime("thread-1").leaseStatus).toBe("blocked"));
    expect(server.calls.some(row => row.method === "thread/unsubscribe")).toBe(false);
    expect(runtime.prepareForAppServerReload()).toMatchObject([{ threadId: "thread-1", reason: "unreleased_runtime" }]);
    await runtime.sendInput("thread-1", { text: "continue" });
    expect(runtime.getRuntime("thread-1").status).toBe("running");
  });

  it("queues new input behind unsubscribe until unloading is confirmed, then resumes before sending", async () => {
    const server = new Server(), runtime = manager(server); server.deferUnload = true;
    await runtime.resumeThread("thread-1");
    await vi.waitFor(() => expect(runtime.getRuntime("thread-1").leaseStatus).toBe("releasing"));
    const sending = runtime.sendInput("thread-1", { text: "during handoff" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(server.calls.some(row => row.method === "turn/start")).toBe(false);
    server.loaded.delete("thread-1");
    server.emit("notification", { method: "thread/closed", params: { threadId: "thread-1" } });
    await sending;
    const methods = server.calls.map(row => row.method);
    expect(methods.lastIndexOf("thread/resume")).toBeGreaterThan(methods.indexOf("thread/unsubscribe"));
    expect(methods.indexOf("turn/start")).toBeGreaterThan(methods.lastIndexOf("thread/resume"));
  });

  it("falls back only on acquisition conflict and preserves the same thread and client message ID", async () => {
    const server = new Server(); server.external = true;
    const runtime = manager(server, { desktopQueue: await queue(server) });
    const result = await runtime.sendInput("thread-1", { text: "continue", clientRequestId: "request-1", allowExternalQueue: true });
    expect(result).toMatchObject({ threadId: "thread-1", executionSource: "external_queue", deliveries: [{ status: "queued" }] });
    expect(server.calls.find(row => row.method === "thread/queue/add")?.params).toMatchObject({ threadId: "thread-1", clientUserMessageId: "request-1" });
    await runtime.sendInput("thread-1", { text: "continue", clientRequestId: "request-1", allowExternalQueue: true });
    expect(server.calls.filter(row => row.method === "thread/queue/add")).toHaveLength(1);
    expect(server.calls.some(row => row.method === "thread/start")).toBe(false);
  });

  it("does not queue after a potentially submitted turn fails or for controlled users and attachments", async () => {
    const server = new Server(), runtime = manager(server, { desktopQueue: await queue(server) });
    server.turnError = true;
    await expect(runtime.sendInput("thread-1", { text: "continue", clientRequestId: "request-1", allowExternalQueue: true })).rejects.toThrow("turn/start timeout");
    expect(server.calls.some(row => row.method === "thread/queue/add")).toBe(false);
    server.external = true;
    await expect(runtime.sendInput("thread-2", { text: "continue", clientRequestId: "request-2", allowExternalQueue: false })).rejects.toThrow("active writer");
    await expect(runtime.sendInput("thread-3", { text: "continue", clientRequestId: "request-3", allowExternalQueue: true, attachmentPaths: ["/file"] })).rejects.toMatchObject({ code: "DESKTOP_QUEUE_TEXT_ONLY" });
    expect(server.calls.some(row => row.method === "thread/queue/add")).toBe(false);
  });

  it("preserves pending queue order after a Manage restart without acquiring the writer", async () => {
    const server = new Server(), desktopQueue = await queue(server);
    await desktopQueue.enqueue("thread-1", "before-restart", "first");
    const runtime = manager(server, { desktopQueue });
    const result = await runtime.sendInput("thread-1", { text: "second", clientRequestId: "after-restart", allowExternalQueue: true });
    expect(result.executionSource).toBe("external_queue");
    expect(server.calls.some(row => row.method === "thread/resume" || row.method === "turn/start")).toBe(false);
    expect(server.calls.filter(row => row.method === "thread/queue/add").map(row => row.params.clientUserMessageId)).toEqual(["before-restart", "after-restart"]);
  });
});
