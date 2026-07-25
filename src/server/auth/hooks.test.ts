import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { registerAuthHook } from "./hooks";

describe("registerAuthHook", () => {
  it("allows the desktop control token to call runtime reload only on the intended control paths", async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    registerAuthHook(app, { authenticate: () => null } as any, "desktop-token");
    app.post("/api/runtime/reload", async () => ({ ok: true }));
    app.get("/api/sessions", async () => ({ sessions: [] }));

    const reload = await app.inject({
      method: "POST",
      url: "/api/runtime/reload",
      headers: { "x-codex-desktop-token": "desktop-token" }
    });
    const sessions = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { "x-codex-desktop-token": "desktop-token" }
    });

    expect(reload.statusCode).toBe(200);
    expect(sessions.statusCode).toBe(401);
    await app.close();
  });
});
