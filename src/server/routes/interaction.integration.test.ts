import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { RuntimeManager } from "../services/RuntimeManager";
import { registerAuthHook } from "../auth/hooks";
import { registerAuthRoutes } from "./auth";
import { registerSessionRoutes } from "./sessions";

it("recovers an authenticated pending question over HTTP and clears both WebSocket clients after one original-RPC answer", async () => {
  const transport = new EventEmitter() as EventEmitter & { respondToServerRequest: (id: string | number, result: unknown) => void };
  const replies: unknown[] = [];
  transport.respondToServerRequest = (id, result) => replies.push({ id, result });
  const manager = new RuntimeManager(transport as any);
  const app = Fastify();
  const sockets: Array<{ terminate: () => void }> = [];
  try {
    await app.register(cookie, { secret: "isolated-interaction-integration-test-secret" });
    await app.register(websocket);
    registerAuthHook(app);
    registerAuthRoutes(app, { password: "interaction-test-only", defaultPassword: false } as any);
    registerSessionRoutes(app, { getPermissionMode: async () => "default" } as any, undefined, manager);
    await app.ready();
    const denied = await app.inject({ method: "GET", url: "/api/sessions/thread-1/runtime" });
    expect(denied.statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "interaction-test-only" } });
    expect(login.statusCode).toBe(200);
    const headers = { cookie: login.cookies.map(row => `${row.name}=${row.value}`).join("; ") };
    transport.emit("notification", { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    transport.emit("serverRequest", { id: "original-input-rpc", method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", turnId: "turn-1", questions: [{ id: "ui", header: "界面", question: "选择版本", options: [{ label: "V3", description: "第三版" }] }]
    } });
    const recovered = await app.inject({ method: "GET", url: "/api/sessions/thread-1/runtime", headers });
    const { approvals, runtime } = recovered.json();
    expect(runtime.status).toBe("waiting_user");
    expect(approvals).toHaveLength(1);
    const messages: any[][] = [[], []];
    for (const events of messages) sockets.push(await app.injectWS("/api/sessions/thread-1/ws", { headers }, {
      onInit: socket => socket.on("message", (data: unknown) => events.push(JSON.parse(String(data))))
    }));
    await vi.waitFor(() => messages.forEach(events => expect(events.find(event => event.type === "snapshot")?.payload.approvals).toHaveLength(1)));
    const url = `/api/sessions/thread-1/approvals/${encodeURIComponent(approvals[0].id)}`;
    const answer = { decision: "accept", answers: { ui: ["V3"] } };
    const response = await app.inject({ method: "POST", url, headers, payload: answer });
    expect(response.statusCode).toBe(200);
    expect(response.json().runtime.status).toBe("running");
    expect(replies).toEqual([{ id: "original-input-rpc", result: { answers: { ui: { answers: ["V3"] } } } }]);
    await vi.waitFor(() => messages.forEach(events => expect(events.filter(event => event.type === "approval_resolved")).toHaveLength(1)));
    const after = await app.inject({ method: "GET", url: "/api/sessions/thread-1/runtime", headers });
    expect(after.json().approvals).toEqual([]);
    expect((await app.inject({ method: "POST", url, headers, payload: answer })).statusCode).toBeGreaterThanOrEqual(400);
    expect(replies).toHaveLength(1);
  } finally {
    sockets.forEach(socket => socket.terminate());
    manager.dispose();
    await app.close();
  }
});
