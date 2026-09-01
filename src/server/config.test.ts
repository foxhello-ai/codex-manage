import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHATGPT_BUNDLED_CODEX_CLI_PATH, loadConfig, validateCodexCliVersion } from "./config";

describe("loadConfig", () => {
  it("uses safe defaults for the MVP server", () => {
    const previous = {
      CODEX_WEB_HOST: process.env.CODEX_WEB_HOST,
      CODEX_WEB_PORT: process.env.CODEX_WEB_PORT,
      CODEX_WEB_PASSWORD: process.env.CODEX_WEB_PASSWORD,
      CODEX_OWNER_NAME: process.env.CODEX_OWNER_NAME,
      CODEX_OWNER_EMAIL: process.env.CODEX_OWNER_EMAIL,
      CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
      CODEX_EXPECTED_CLI_VERSION: process.env.CODEX_EXPECTED_CLI_VERSION,
      CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
      CODEX_MANAGE_METADATA_FILE: process.env.CODEX_MANAGE_METADATA_FILE,
      CODEX_WEB_CLIENT_DIR: process.env.CODEX_WEB_CLIENT_DIR
    };

    delete process.env.CODEX_WEB_HOST;
    delete process.env.CODEX_WEB_PORT;
    delete process.env.CODEX_WEB_PASSWORD;
    delete process.env.CODEX_OWNER_NAME;
    delete process.env.CODEX_OWNER_EMAIL;
    delete process.env.CODEX_CLI_PATH;
    delete process.env.CODEX_EXPECTED_CLI_VERSION;
    delete process.env.CODEX_SESSIONS_DIR;
    delete process.env.CODEX_MANAGE_METADATA_FILE;
    delete process.env.CODEX_WEB_CLIENT_DIR;

    const config = loadConfig();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(4310);
    expect(config.password).toBe("admin");
    expect(config.defaultPassword).toBe(true);
    expect(config.ownerName).toBe("Jamie Chen");
    expect(config.ownerEmail).toBe("jamie@local");
    expect(config.codexCliPath).toBe(
      process.platform === "darwin" && existsSync(CHATGPT_BUNDLED_CODEX_CLI_PATH)
        ? CHATGPT_BUNDLED_CODEX_CLI_PATH
        : "codex"
    );
    expect(config.expectedCodexCliVersion).toBeUndefined();
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

  it("reads the owner identity from the environment", () => {
    const previousName = process.env.CODEX_OWNER_NAME;
    const previousEmail = process.env.CODEX_OWNER_EMAIL;
    process.env.CODEX_OWNER_NAME = "Morgan Lee";
    process.env.CODEX_OWNER_EMAIL = "morgan@example.local";

    const config = loadConfig();

    expect(config.ownerName).toBe("Morgan Lee");
    expect(config.ownerEmail).toBe("morgan@example.local");

    if (previousName === undefined) {
      delete process.env.CODEX_OWNER_NAME;
    } else {
      process.env.CODEX_OWNER_NAME = previousName;
    }
    if (previousEmail === undefined) {
      delete process.env.CODEX_OWNER_EMAIL;
    } else {
      process.env.CODEX_OWNER_EMAIL = previousEmail;
    }
  });

  it("allows an explicit CLI path and expected version", () => {
    const previousPath = process.env.CODEX_CLI_PATH;
    const previousVersion = process.env.CODEX_EXPECTED_CLI_VERSION;
    process.env.CODEX_CLI_PATH = "/opt/codex/bin/codex";
    process.env.CODEX_EXPECTED_CLI_VERSION = "0.149.0";

    const config = loadConfig();

    expect(config.codexCliPath).toBe("/opt/codex/bin/codex");
    expect(config.expectedCodexCliVersion).toBe("0.149.0");

    if (previousPath === undefined) {
      delete process.env.CODEX_CLI_PATH;
    } else {
      process.env.CODEX_CLI_PATH = previousPath;
    }
    if (previousVersion === undefined) {
      delete process.env.CODEX_EXPECTED_CLI_VERSION;
    } else {
      process.env.CODEX_EXPECTED_CLI_VERSION = previousVersion;
    }
  });

  it("validates CLI versions with or without the codex-cli prefix", () => {
    expect(() => validateCodexCliVersion("codex-cli 0.149.0", "0.149.0")).not.toThrow();
    expect(() => validateCodexCliVersion("codex-cli 0.149.0", "codex-cli 0.149.0")).not.toThrow();
    expect(() => validateCodexCliVersion("codex-cli 0.149.0", "0.148.0")).toThrow(
      "Codex CLI 版本不匹配"
    );
  });
});
