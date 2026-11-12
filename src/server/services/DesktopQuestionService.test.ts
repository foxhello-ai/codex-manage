import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { chmod, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopQuestionService } from "./DesktopQuestionService";
import { DesktopIpcClient } from "./DesktopIpcClient";
import { encodeQuestionReply, pendingDesktopQuestions } from "../../shared/desktopQuestions";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const questionId = JSON.stringify(["request_user_input_async", "call_async", 0]);
function state() {
  return { id: "thread-a", cwd: "/test/workspace", turns: [], turnHistory: { kind: "canonical", history: {
    islands: [{ entries: [{ value: "active" }] }], entitiesByKey: { active: { turnId: "turn-a", status: "inProgress", items: [
      { type: "agentMessage", id: "call_async", delivery: "async", questions: [{ title: "请选择界面", options: ["方案 A", "方案 B"] }] }
    ] } }
  } } };
}
async function fixture(mode: "accept" | "unknown" = "accept") {
  const home = await mkdtemp(join(tmpdir(), "dqi-")); await mkdir(join(home, "ipc"), { mode: 0o700 });
  const sockets = new Set<Socket>(), steers: any[] = [];
  const native = state(); let revision = 1;
  function send(socket: Socket, message: unknown) {
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    // Exercise framed IPC, including multiple JSON messages and split headers.
    socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), body]));
  }
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        const response = (result: any) => send(socket, { type: "response", requestId: request.requestId, resultType: "success", method: request.method, handledByClientId: "owner-a", result });
        if (request.method === "initialize") response({ clientId: "manage-client" });
        else if (request.method === "thread-owner-discovery") {
          if (request.params.conversationId === "thread-a") response({ supportsUntrustedAppInput: true });
          else send(socket, { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" });
        } else if (request.method === "thread-stream-following-changed" && request.params.following) {
          send(socket, { type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "owner-a", params: { conversationId: "thread-a", hostId: "local", change: { type: "snapshot", revision, conversationState: native } } });
        } else if (request.method === "thread-follower-steer-turn") {
          steers.push(request); if (mode === "accept") response({ result: { turnId: "turn-a" } });
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, "ipc", "ipc.sock"), resolve));
  await chmod(join(home, "ipc", "ipc.sock"), 0o600);
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  function service() {
    const result = new DesktopQuestionService(home, join(home, "answers.json"), path => new DesktopIpcClient(path, 100));
    cleanup.push(() => result.dispose()); return result;
  }
  return { home, native, service, steers, patch(patches: any[]) {
    for (const socket of sockets) send(socket, { type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "owner-a", params: { conversationId: "thread-a", hostId: "local", change: { type: "patches", baseRevision: revision, revision: revision + 1, patches } } });
    revision++;
  } };
}
describe("desktop async question IPC", () => {
  it("reads a canonical live turn and submits a correlated custom answer once across concurrent clients", async () => {
    const f = await fixture(), service = f.service();
    expect(await service.read("thread-a")).toMatchObject({ available: true, turnId: "turn-a", questions: [{ id: questionId, options: ["方案 A", "方案 B"] }] });
    const [a, b] = await Promise.all([service.submit("thread-a", "turn-a", questionId, "请查看售后界面"), service.submit("thread-a", "turn-a", questionId, "请查看售后界面")]);
    expect(a.submissions).toEqual([{ questionId, status: "accepted" }]); expect(b.submissions).toEqual(a.submissions);
    expect(f.steers).toHaveLength(1);
    expect(f.steers[0]).toMatchObject({ version: 1, targetClientId: "owner-a", params: { conversationId: "thread-a", input: [{ type: "text", text: encodeQuestionReply({ questionItemId: questionId, question: "请选择界面", answer: "请查看售后界面" }) }] } });
    expect(f.steers[0].params).not.toHaveProperty("model");
    await expect(service.submit("thread-a", "turn-a", questionId, "不同答案")).rejects.toMatchObject({ code: "QUESTION_REPLY_CONFLICT" });
  });
  it("does not send stale turn IDs, fabricated questions or questions from another thread", async () => {
    const f = await fixture(), service = f.service();
    await expect(service.submit("thread-a", "older-turn", questionId, "方案 B")).rejects.toMatchObject({ code: "DESKTOP_QUESTION_STALE" });
    await expect(service.submit("thread-a", "turn-a", "invented-id", "方案 B")).rejects.toMatchObject({ code: "DESKTOP_QUESTION_STALE" });
    await expect(service.submit("thread-b", "turn-a", questionId, "方案 B")).rejects.toMatchObject({ code: "DESKTOP_QUESTION_UNAVAILABLE" });
    expect(f.steers).toHaveLength(0);
  });
  it("does not replay uncertain delivery after a timeout or Manage restart", async () => {
    const f = await fixture("unknown"), service = f.service();
    expect((await service.submit("thread-a", "turn-a", questionId, "方案 B")).submissions).toEqual([{ questionId, status: "unknown" }]);
    service.dispose();
    expect((await f.service().submit("thread-a", "turn-a", questionId, "方案 B")).submissions).toEqual([{ questionId, status: "unknown" }]);
    expect(f.steers).toHaveLength(1);
    expect(JSON.parse(await readFile(join(f.home, "answers.json"), "utf8"))[0].status).toBe("unknown");
  });
  it("clears questions answered on the desktop through live patches without reopening", async () => {
    const f = await fixture(), service = f.service(); await service.read("thread-a");
    f.patch([{ op: "add", path: ["turnHistory", "history", "entitiesByKey", "active", "items", 1], value: { type: "steeringUserMessage", status: "accepted", input: [{ type: "text", text: encodeQuestionReply({ questionItemId: questionId, question: "请选择界面", answer: "方案 B" }) }] } }]);
    await expect.poll(async () => (await service.read("thread-a")).questions).toEqual([]);
    await expect(service.submit("thread-a", "turn-a", questionId, "方案 A")).rejects.toMatchObject({ code: "DESKTOP_QUESTION_STALE" });
  });
  it("reconciles a lost acknowledgement only from the matching accepted desktop message", async () => {
    const f = await fixture("unknown"), service = f.service();
    await service.submit("thread-a", "turn-a", questionId, "方案 B");
    const requestId = f.steers[0].params.clientUserMessageId;
    const reply = { type: "steeringUserMessage", status: "pending", clientUserMessageId: requestId,
      input: [{ type: "text", text: encodeQuestionReply({ questionItemId: questionId, question: "请选择界面", answer: "方案 B" }) }] };
    const path = ["turnHistory", "history", "entitiesByKey", "active", "items", 1];
    f.patch([{ op: "add", path, value: reply }]);
    expect((await service.read("thread-a")).submissions[0].status).toBe("unknown");
    f.patch([{ op: "replace", path: [...path, "status"], value: "accepted" }]);
    await expect.poll(async () => (await service.read("thread-a")).submissions[0].status).toBe("accepted");
    expect((await service.read("thread-a")).questions).toEqual([]);
    expect(f.steers).toHaveLength(1);
  });
  it("expires cards when their original turn ends, retaining historical questions", async () => {
    const f = await fixture(), service = f.service(); await service.read("thread-a");
    f.patch([{ op: "replace", path: ["turnHistory", "history", "entitiesByKey", "active", "status"], value: "completed" }]);
    await expect.poll(async () => (await service.read("thread-a")).turnId).toBe(null);
    expect(pendingDesktopQuestions({ turns: [{ turnId: "old", status: "completed", items: f.native.turnHistory.history.entitiesByKey.active.items }] }).questions).toEqual([]);
  });
  it("does not treat a pending/rejected optimistic reply as an answer", () => {
    const source = state();
    const turn: any = source.turnHistory.history.entitiesByKey.active;
    turn.items.push({ type: "steeringUserMessage", status: "pending", input: [{ type: "text", text: encodeQuestionReply({ questionItemId: questionId, question: "请选择界面", answer: "方案 B" }) }] });
    expect(pendingDesktopQuestions(source).questions).toHaveLength(1);
    turn.items.at(-1).status = "accepted";
    expect(pendingDesktopQuestions(source).questions).toHaveLength(0);
  });
});
