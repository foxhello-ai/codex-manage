import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "./CodexAppServerClient";

type FakeProcess = EventEmitter & {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function createFakeProcess(): FakeProcess {
  const process = new EventEmitter() as FakeProcess;
  process.pid = 1234;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.killed = false;
  process.kill = () => {
    process.killed = true;
    process.emit("exit", 0, null);
    return true;
  };
  return process;
}

function readJsonLines(stream: PassThrough, onMessage: (message: any) => void) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onMessage(JSON.parse(line));
    }
  });
}

describe("CodexAppServerClient", () => {
  it("routes string request IDs and writes protocol replies and unsupported-request errors", async () => {
    const fake = createFakeProcess();
    const outgoing: any[] = [];
    readJsonLines(fake.stdin, message => {
      outgoing.push(message);
      if (message.method === "initialize") fake.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    });
    const client = new CodexAppServerClient({ codexCliPath: "codex", spawnProcess: (() => fake) as any });
    const incoming: any[] = [];
    client.on("serverRequest", request => incoming.push(request));
    await client.start();
    fake.stdout.write(`${JSON.stringify({ id: "question-rpc", method: "item/tool/requestUserInput", params: { threadId: "t1" } })}\n`);
    expect(incoming[0].id).toBe("question-rpc");
    client.respondToServerRequest("question-rpc", { answers: {} });
    client.rejectServerRequest("unknown-rpc", "Unsupported request");
    expect(outgoing.slice(-2)).toEqual([
      { id: "question-rpc", result: { answers: {} } },
      { id: "unknown-rpc", error: { code: -32601, message: "Unsupported request" } }
    ]);
    await client.stop();
  });
  it("starts app-server and completes initialize handshake", async () => {
    const fake = createFakeProcess();
    const messages: any[] = [];
    readJsonLines(fake.stdin, (message) => {
      messages.push(message);
      if (message.method === "initialize") {
        fake.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "codex-test" } })}\n`);
      }
    });

    const client = new CodexAppServerClient({
      codexCliPath: "codex",
      spawnProcess: (() => fake) as any
    });

    await client.start();

    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      pid: 1234,
      initialized: true
    });
    expect(messages.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(messages[0].params.clientInfo.version).toBe("1.0.0");
  });

  it("routes responses, notifications, and server requests", async () => {
    const fake = createFakeProcess();
    readJsonLines(fake.stdin, (message) => {
      if (message.method === "initialize") {
        fake.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
      if (message.method === "thread/list") {
        fake.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
      }
    });

    const client = new CodexAppServerClient({
      codexCliPath: "codex",
      spawnProcess: (() => fake) as any
    });

    const notifications: any[] = [];
    const serverRequests: any[] = [];
    client.on("notification", (message) => notifications.push(message));
    client.on("serverRequest", (message) => serverRequests.push(message));

    await client.start();
    const result = await client.request("thread/list", { limit: 10 });
    fake.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "t1" } })}\n`);
    fake.stdout.write(`${JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } })}\n`);

    expect(result).toEqual({ data: [] });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe("turn/started");
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0].method).toBe("item/commandExecution/requestApproval");
  });

  it("reports startup failures", async () => {
    const client = new CodexAppServerClient({
      codexCliPath: "missing-codex",
      spawnProcess: (() => {
        throw new Error("not found");
      }) as any
    });
    client.on("error", () => {
      // Expected for this test.
    });

    await expect(client.start()).rejects.toThrow("not found");
    expect(client.getSnapshot()).toMatchObject({
      status: "failed",
      lastError: "not found",
      initialized: false
    });
  });

  it("times out unanswered requests and clears pending state", async () => {
    const fake = createFakeProcess();
    readJsonLines(fake.stdin, (message) => {
      if (message.method === "initialize") {
        fake.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    });

    const client = new CodexAppServerClient({
      codexCliPath: "codex",
      requestTimeoutMs: 5,
      spawnProcess: (() => fake) as any
    });

    await client.start();
    await expect(client.request("thread/resume", { threadId: "thread-1" })).rejects.toThrow(
      "codex app-server request timed out: thread/resume"
    );
  });
});
