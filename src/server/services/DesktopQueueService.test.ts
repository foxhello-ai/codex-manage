import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopQueueService } from "./DesktopQueueService";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(request: (method: string, params: any) => Promise<any>) {
  const directory = await mkdtemp(join(tmpdir(), "manage-queue-")); directories.push(directory);
  const file = join(directory, "deliveries.json");
  return { service: new DesktopQueueService({ request: request as any }, file), file };
}

describe("DesktopQueueService", () => {
  it("does not freeze a transient interrupted snapshot as failure before the desktop persists completion", async () => {
    let completed = false;
    const { service } = await setup(async (method, params) => {
      if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-1", clientUserMessageId: params.clientUserMessageId } };
      if (method === "thread/queue/list") return { data: [] };
      return { data: [{ id: "turn-1", status: completed ? "completed" : "interrupted", error: null, items: [{ id: "item-1", type: "userMessage", clientId: "request-1" }] }] };
    });
    await service.enqueue("thread-1", "request-1", "hello");
    expect((await service.refresh("thread-1"))[0]).toMatchObject({ status: "observed", turnId: "turn-1" });
    completed = true;
    expect((await service.refresh("thread-1"))[0]).toMatchObject({ status: "completed", error: null });
  });

  it("persists before enqueue, correlates native client IDs, and never resends the same request after restart", async () => {
    let calls = 0;
    const request = async (method: string, params: any) => {
      expect(method).toBe("thread/queue/add"); calls++;
      const stored = JSON.parse(await readFile(file, "utf8"));
      expect(stored[0].status).toBe("submitting");
      return { queuedSubmission: { id: "queue-1", clientUserMessageId: params.clientUserMessageId } };
    };
    const { service, file } = await setup(request);
    const [first, repeated] = await Promise.all([service.enqueue("thread-1", "request-1", "同一句话"), service.enqueue("thread-1", "request-1", "同一句话")]);
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({ status: "queued", queueId: "queue-1" });
    const restarted = new DesktopQueueService({ request: request as any }, file);
    expect(await restarted.enqueue("thread-1", "request-1", "同一句话")).toEqual(first);
    expect(calls).toBe(1);
    await expect(restarted.enqueue("another-thread", "request-1", "同一句话")).rejects.toMatchObject({ code: "INPUT_REQUEST_CONFLICT" });
  });

  it("recovers a timed-out enqueue only from matching native IDs, not another identical message", async () => {
    let matched = false, addCalls = 0;
    const { service } = await setup(async method => {
      if (method === "thread/queue/add") { addCalls++; throw Error("RPC timeout"); }
      if (method === "thread/queue/list") return { data: [] };
      return { data: [{ id: "turn-1", status: "completed", items: [{ type: "userMessage", id: "item-1", clientId: matched ? "request-1" : "some-other-request" }] }] };
    });
    expect(await service.enqueue("thread-1", "request-1", "相同文字")).toMatchObject({ status: "unknown" });
    expect((await service.refresh("thread-1"))[0].status).toBe("unknown");
    matched = true;
    expect((await service.refresh("thread-1"))[0]).toMatchObject({ status: "completed", turnId: "turn-1", itemId: "item-1" });
    expect(addCalls).toBe(1);
  });

  it("keeps two deliberate identical messages distinct and follows pagination", async () => {
    const { service } = await setup(async (method, params) => {
      if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-" + params.clientUserMessageId, clientUserMessageId: params.clientUserMessageId } };
      if (method === "thread/queue/list") return { data: [] };
      if (!params.cursor) return { data: [{ id: "turn-2", status: "inProgress", items: [{ type: "userMessage", id: "item-2", clientId: "request-2" }] }], nextCursor: "older" };
      return { data: [{ id: "turn-1", status: "completed", items: [{ type: "userMessage", id: "item-1", clientId: "request-1" }] }] };
    });
    await service.enqueue("thread-1", "request-1", "重复文字");
    await service.enqueue("thread-1", "request-2", "重复文字");
    expect(await service.refresh("thread-1")).toMatchObject([{ status: "completed", itemId: "item-1" }, { status: "observed", itemId: "item-2" }]);
  });

  it("recovers a process crash during submitting as unknown without invoking add again", async () => {
    const { file } = await setup(async () => { throw Error("must not send"); });
    await writeFile(file, JSON.stringify([{ requestId: "request-1", threadId: "thread-1", text: "hello", status: "submitting", queueId: null, turnId: null, itemId: null, error: null, createdAt: new Date().toISOString() }]));
    const restarted = new DesktopQueueService({ request: async () => { throw Error("must not send"); } }, file);
    expect(await restarted.enqueue("thread-1", "request-1", "hello")).toMatchObject({ status: "unknown" });
  });

  it("reports unsupported native queues as a capability error and does not corrupt malformed storage", async () => {
    const { service, file } = await setup(async () => { throw Error("Method not found"); });
    await expect(service.enqueue("thread-1", "request-1", "hello")).rejects.toMatchObject({ code: "DESKTOP_QUEUE_UNAVAILABLE" });
    await expect(service.enqueue("thread-1", "request-1", "hello")).rejects.toMatchObject({ code: "DESKTOP_QUEUE_UNAVAILABLE" });
    await writeFile(file, "invalid json");
    const restarted = new DesktopQueueService({ request: async () => ({}) as any }, file);
    await expect(restarted.enqueue("thread-1", "request-2", "hello")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("invalid json");
  });
});
