import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWebApplication } from "./app";
import { loadConfig } from "./config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("createLocalWebApplication", () => {
  it("builds a Fastify application without listening or starting Codex", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-app-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      runtimeMode: "desktop",
      host: "127.0.0.1",
      port: 0,
      userDataDir: directory,
      metadataFile: join(directory, "session-metadata.json"),
      localDatabaseFile: ":memory:",
      clientDir: join(directory, "client")
    });
    const { app } = await createLocalWebApplication(config, {
      logger: false,
      serveStatic: false
    });

    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(app.server.listening).toBe(false);

    await app.close();
  });
});
