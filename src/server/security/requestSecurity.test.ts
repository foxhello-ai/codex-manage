import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRequestSecurityHook, isAllowedHostname } from "./requestSecurity";
import { LocalRateLimiter } from "./LocalRateLimiter";

describe("request security", () => {
  it("matches exact hosts and controlled wildcard suffixes", () => {
    const allowed = ["localhost", "*.trycloudflare.com", "*.foxhello.com", "*.xmwefun.cn"];

    expect(isAllowedHostname("localhost", allowed)).toBe(true);
    expect(isAllowedHostname("quiet-tree.trycloudflare.com", allowed)).toBe(true);
    expect(isAllowedHostname("d-a83k2m.xmwefun.cn", allowed)).toBe(true);
    expect(isAllowedHostname("d-a83k2m.foxhello.com", allowed)).toBe(true);
    expect(isAllowedHostname("trycloudflare.com.attacker.test", allowed)).toBe(false);
    expect(isAllowedHostname("xmwefun.cn", allowed)).toBe(false);
  });

  it("rejects invalid hosts and cross-origin state changes", async () => {
    const app = Fastify();
    registerRequestSecurityHook(app, {
      enforceHostCheck: true,
      allowedHosts: ["localhost", "127.0.0.1"]
    } as never);
    app.post("/api/test", async () => ({ ok: true }));

    const invalidHost = await app.inject({
      method: "POST",
      url: "/api/test",
      headers: { host: "attacker.test" }
    });
    const invalidOrigin = await app.inject({
      method: "POST",
      url: "/api/test",
      headers: { host: "localhost", origin: "https://attacker.test" }
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/api/test",
      headers: { host: "localhost", origin: "http://localhost" }
    });

    expect(invalidHost.statusCode).toBe(421);
    expect(invalidOrigin.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);

    await app.close();
  });
});

describe("LocalRateLimiter", () => {
  it("limits repeated attempts inside a fixed window", () => {
    const limiter = new LocalRateLimiter();

    expect(limiter.consume("login:127.0.0.1", 2, 60_000, 1000).allowed).toBe(true);
    expect(limiter.consume("login:127.0.0.1", 2, 60_000, 1001).allowed).toBe(true);
    expect(limiter.consume("login:127.0.0.1", 2, 60_000, 1002)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60
    });
    expect(limiter.consume("login:127.0.0.1", 2, 60_000, 61_001).allowed).toBe(true);
  });
});
