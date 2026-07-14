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
      CODEX_MANAGE_METADATA_FILE: process.env.CODEX_MANAGE_METADATA_FILE
    };

    delete process.env.CODEX_WEB_HOST;
    delete process.env.CODEX_WEB_PORT;
    delete process.env.CODEX_WEB_PASSWORD;
    delete process.env.CODEX_CLI_PATH;
    delete process.env.CODEX_SESSIONS_DIR;
    delete process.env.CODEX_MANAGE_METADATA_FILE;

    const config = loadConfig();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.password).toBe("admin");
    expect(config.codexCliPath).toBe("codex");
    expect(config.sessionsDir).toContain(".codex/sessions");
    expect(config.metadataFile).toContain(".codex-manage/session-metadata.json");

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
});
