import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthHook } from "../auth/hooks";
import type { AppConfig } from "../config";
import { registerAuthRoutes } from "./auth";
import { registerConfigRoutes } from "./config";

function testConfig(): AppConfig {
  return {
    host: "0.0.0.0",
    port: 3000,
    password: "fmzh2026",
    sessionSecret: "test-secret-at-least-thirty-two-chars",
    codexCliPath: "codex",
    sessionsDir: "/tmp/sessions",
    metadataFile: "/tmp/codex-manage-test-session-metadata.json",
    clientDir: "/tmp/codex-manage-test-client"
  };
}

async function buildApp() {
  const app = Fastify();
  const config = testConfig();

  await app.register(cookie, {
    secret: config.sessionSecret
  });

  registerAuthHook(app);
  registerAuthRoutes(app, config);
  registerConfigRoutes(app, config);
  await app.ready();

  return app;
}

describe("auth routes", () => {
  it("allows the login page to check /api/me before authentication", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/me"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authenticated: false,
      defaultPassword: false
    });
  });

  it("keeps management config protected until login and supports logout", async () => {
    const app = await buildApp();

    const blocked = await app.inject({
      method: "GET",
      url: "/api/config"
    });
    expect(blocked.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: {
        password: "fmzh2026"
      }
    });
    expect(login.statusCode).toBe(200);

    const cookieHeader = login.headers["set-cookie"];
    const sessionCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    expect(sessionCookie).toContain("codex_manage_session=");

    const allowed = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: {
        cookie: sessionCookie
      }
    });
    expect(allowed.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: {
        cookie: sessionCookie
      }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({
      authenticated: false,
      defaultPassword: false
    });
  });
});
