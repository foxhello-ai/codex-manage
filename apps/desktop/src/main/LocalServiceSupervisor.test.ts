import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalServiceSupervisor } from "./LocalServiceSupervisor";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalServiceSupervisor", () => {
  it("waits for the ready marker and stops the managed process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-local-supervisor-"));
    directories.push(directory);
    const entry = join(directory, "fake-server.cjs");
    await writeFile(entry, `
      process.stdout.write('CODEX_MANAGE_READY {"url":"http://127.0.0.1:4310","port":4310}\\n');
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    await chmod(entry, 0o755);

    const supervisor = new LocalServiceSupervisor({
      electronExecutable: process.execPath,
      serverEntry: entry,
      clientDir: directory,
      userDataDir: directory,
      port: 4310,
      controlToken: "test-control-token",
      codexCliPath: "codex"
    });

    await expect(supervisor.start()).resolves.toMatchObject({
      state: "running",
      url: "http://127.0.0.1:4310",
      port: 4310
    });
    await supervisor.stop();
    expect(supervisor.getSnapshot().state).toBe("stopped");
  });
});
