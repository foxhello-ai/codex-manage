import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("uses safe defaults for the MVP server", () => {
    const previous = {
      CODEX_WEB_HOST: process.env.CODEX_WEB_HOST,
      CODEX_WEB_PORT: process.env.CODEX_WEB_PORT,
      CODEX_WEB_PASSWORD: process.env.CODEX_WEB_PASSWORD,
      CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
      CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
      CODEX_MANAGE_RUNTIME_MODE: process.env.CODEX_MANAGE_RUNTIME_MODE,
      CODEX_MANAGE_USER_DATA_DIR: process.env.CODEX_MANAGE_USER_DATA_DIR,
      CODEX_MANAGE_METADATA_FILE: process.env.CODEX_MANAGE_METADATA_FILE,
      CODEX_MANAGE_DATABASE_FILE: process.env.CODEX_MANAGE_DATABASE_FILE,
      CODEX_WEB_CLIENT_DIR: process.env.CODEX_WEB_CLIENT_DIR
    };

    delete process.env.CODEX_WEB_HOST;
    delete process.env.CODEX_WEB_PORT;
    delete process.env.CODEX_WEB_PASSWORD;
    delete process.env.CODEX_CLI_PATH;
    delete process.env.CODEX_SESSIONS_DIR;
    delete process.env.CODEX_MANAGE_RUNTIME_MODE;
    delete process.env.CODEX_MANAGE_USER_DATA_DIR;
    delete process.env.CODEX_MANAGE_METADATA_FILE;
    delete process.env.CODEX_MANAGE_DATABASE_FILE;
    delete process.env.CODEX_WEB_CLIENT_DIR;

    const config = loadConfig();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(4310);
    expect(config.password).toBe("fmzh2026");
    expect(config.defaultPassword).toBe(true);
    expect(config.codexCliPath).toBe("codex");
    expect(config.sessionsDir).toContain(".codex/sessions");
    expect(config.userDataDir).toContain(".codex-manage");
    expect(config.metadataFile).toContain(".codex-manage/session-metadata.json");
    expect(config.localDatabaseFile).toContain(".codex-manage/local.db");
    expect(config.clientDir).toContain("dist/client");

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses loopback and the injected data directory in desktop mode", () => {
    const previousMode = process.env.CODEX_MANAGE_RUNTIME_MODE;
    const previousUserDataDir = process.env.CODEX_MANAGE_USER_DATA_DIR;
    const previousHost = process.env.CODEX_WEB_HOST;
    const previousSessionSecret = process.env.CODEX_WEB_SESSION_SECRET;

    process.env.CODEX_MANAGE_RUNTIME_MODE = "desktop";
    process.env.CODEX_MANAGE_USER_DATA_DIR = "/tmp/codex-manage-desktop";
    process.env.CODEX_WEB_SESSION_SECRET = "desktop-test-session-secret-at-least-32";
    delete process.env.CODEX_WEB_HOST;

    const config = loadConfig();

    expect(config.runtimeMode).toBe("desktop");
    expect(config.host).toBe("127.0.0.1");
    expect(config.metadataFile).toBe("/tmp/codex-manage-desktop/session-metadata.json");
    expect(config.localDatabaseFile).toBe("/tmp/codex-manage-desktop/local.db");

    if (previousMode === undefined) delete process.env.CODEX_MANAGE_RUNTIME_MODE;
    else process.env.CODEX_MANAGE_RUNTIME_MODE = previousMode;
    if (previousUserDataDir === undefined) delete process.env.CODEX_MANAGE_USER_DATA_DIR;
    else process.env.CODEX_MANAGE_USER_DATA_DIR = previousUserDataDir;
    if (previousHost === undefined) delete process.env.CODEX_WEB_HOST;
    else process.env.CODEX_WEB_HOST = previousHost;
    if (previousSessionSecret === undefined) delete process.env.CODEX_WEB_SESSION_SECRET;
    else process.env.CODEX_WEB_SESSION_SECRET = previousSessionSecret;
  });

  it("records when the password comes from the environment", () => {
    const previousPassword = process.env.CODEX_WEB_PASSWORD;
    process.env.CODEX_WEB_PASSWORD = "configured-password";

    const config = loadConfig();

    expect(config.password).toBe("configured-password");
    expect(config.defaultPassword).toBe(false);

    if (previousPassword === undefined) {
      delete process.env.CODEX_WEB_PASSWORD;
    } else {
      process.env.CODEX_WEB_PASSWORD = previousPassword;
    }
  });
});
