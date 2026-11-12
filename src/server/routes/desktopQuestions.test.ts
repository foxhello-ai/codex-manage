import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { registerAuthHook } from "../auth/hooks";
import { registerAuthRoutes } from "./auth";
import { registerSessionRoutes } from "./sessions";
import { CollaborationStore } from "../services/CollaborationStore";

it("protects desktop question reads/writes with owner authentication and canonical answer fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-question-auth-"));
  const app = Fastify();
  try {
    const store = new CollaborationStore(join(directory, "users.json"));
    const child = await store.createChild({ displayName: "Test", localEmail: "test@local", password: "child-test" });
    await store.replaceGrants(child.collaborator.id, ["thread-a"]);
    const read = vi.fn(async () => ({ available: true, turnId: "turn-a", questions: [], submissions: [] }));
    const submit = vi.fn(read);
    await app.register(cookie, { secret: "desktop-question-test-secret-at-least-32-characters" });
    registerAuthHook(app, store);
    registerAuthRoutes(app, { password: "owner-test", defaultPassword: false } as any, store);
    registerSessionRoutes(app, {} as any, undefined, undefined, undefined, store, undefined, { read, submit });
    const url = "/api/sessions/thread-a/desktop-questions";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const login = async (accountId: string, password: string) => {
      const response = await app.inject({ method: "POST", url: "/api/login", payload: { accountId, password } });
      return { cookie: response.cookies.map(row => `${row.name}=${row.value}`).join("; ") };
    };
    const childHeaders = await login(child.collaborator.id, "child-test");
    expect((await app.inject({ method: "GET", url, headers: childHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: childHeaders, payload: {} })).statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    const headers = await login("owner", "owner-test");
    expect((await app.inject({ method: "POST", url, headers, payload: { turnId: "turn-a", questionId: "question", answer: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers, payload: { turnId: "turn-a", questionId: "question", answer: "B", question: "spoofed title", method: "turn/start" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers, payload: { turnId: "turn-a", questionId: "question", answer: "  方案 B  " } })).statusCode).toBe(200);
    expect(submit).toHaveBeenCalledExactlyOnceWith("thread-a", "turn-a", "question", "方案 B");
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
