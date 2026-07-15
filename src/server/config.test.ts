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
      CODEX_MANAGE_METADATA_FILE: process.env.CODEX_MANAGE_METADATA_FILE,
      CODEX_WEB_CLIENT_DIR: process.env.CODEX_WEB_CLIENT_DIR
    };

    delete process.env.CODEX_WEB_HOST;
    delete process.env.CODEX_WEB_PORT;
    delete process.env.CODEX_WEB_PASSWORD;
    delete process.env.CODEX_CLI_PATH;
    delete process.env.CODEX_SESSIONS_DIR;
    delete process.env.CODEX_MANAGE_METADATA_FILE;
    delete process.env.CODEX_WEB_CLIENT_DIR;

    const config = loadConfig();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.password).toBe("fmzh2026");
    expect(config.defaultPassword).toBe(true);
    expect(config.codexCliPath).toBe("codex");
    expect(config.sessionsDir).toContain(".codex/sessions");
    expect(config.metadataFile).toContain(".codex-manage/session-metadata.json");
    expect(config.clientDir).toContain("dist/client");

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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
