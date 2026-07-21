import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthHook } from "../auth/hooks";
import { LocalAuthService } from "../auth/LocalAuthService";
import type { AppConfig } from "../config";
import { registerAuthRoutes } from "./auth";
import { registerConfigRoutes } from "./config";

function testConfig(): AppConfig {
  return {
    runtimeMode: "standalone",
    host: "0.0.0.0",
    port: 3000,
    password: "fmzh2026",
    defaultPassword: false,
    sessionSecret: "test-secret-at-least-thirty-two-chars",
    codexCliPath: "codex",
    sessionsDir: "/tmp/sessions",
    userDataDir: "/tmp/codex-manage-auth-test",
    metadataFile: "/tmp/codex-manage-test-session-metadata.json",
    localDatabaseFile: ":memory:",
    clientDir: "/tmp/codex-manage-test-client",
    allowedHosts: ["localhost", "127.0.0.1"],
    enforceHostCheck: true,
    sessionTtlSeconds: 3600,
    pairingCodeTtlSeconds: 300,
    desktopControlToken: null
  };
}

async function buildApp() {
  const app = Fastify();
  const config = testConfig();
  const authService = new LocalAuthService({
    databaseFile: ":memory:",
    bootstrapPassword: config.password,
    bootstrapPasswordIsDefault: false,
    sessionTtlSeconds: config.sessionTtlSeconds,
    pairingCodeTtlSeconds: config.pairingCodeTtlSeconds
  });

  await app.register(cookie, {
    secret: config.sessionSecret
  });

  registerAuthHook(app, authService);
  registerAuthRoutes(app, config, authService);
  registerConfigRoutes(app, config);
  app.addHook("onClose", async () => authService.close());
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
      defaultPassword: false,
      setupRequired: false
    });

    await app.close();
  });

  it("keeps management config protected until login and supports logout", async () => {
    const app = await buildApp();

    const blocked = await app.inject({
      method: "GET",
      url: "/api/config"
    });
    expect(blocked.statusCode).toBe(401);

    const blockedHealth = await app.inject({
      method: "GET",
      url: "/api/health"
    });
    expect(blockedHealth.statusCode).toBe(401);

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
      defaultPassword: false,
      setupRequired: false
    });

    await app.close();
  });

  it("creates a one-time pairing session and supports session revocation", async () => {
    const app = await buildApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "fmzh2026" }
    });
    const loginCookieHeader = login.headers["set-cookie"];
    const loginCookie = Array.isArray(loginCookieHeader) ? loginCookieHeader[0] : loginCookieHeader;
    expect(loginCookie).toBeTruthy();

    const codeResponse = await app.inject({
      method: "POST",
      url: "/api/local-auth/pairing-code",
      headers: { cookie: loginCookie! }
    });
    expect(codeResponse.statusCode).toBe(200);
    const code = codeResponse.json().code as string;

    const pair = await app.inject({
      method: "POST",
      url: "/api/local-auth/pair",
      payload: { code }
    });
    expect(pair.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/local-auth/pair",
      payload: { code }
    });
    expect(replay.statusCode).toBe(401);

    const sessions = await app.inject({
      method: "GET",
      url: "/api/local-auth/sessions",
      headers: { cookie: loginCookie! }
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions).toHaveLength(2);

    await app.close();
  });
});
