import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const codexBinDirectory = join(directory, "nvm", "bin");
    const codexCliPath = join(codexBinDirectory, "codex");
    const environmentFile = join(directory, "environment.json");
    await mkdir(codexBinDirectory, { recursive: true });
    await writeFile(codexCliPath, "#!/bin/sh\nexit 0\n");
    await chmod(codexCliPath, 0o755);
    await writeFile(entry, `
      require('node:fs').writeFileSync(${JSON.stringify(environmentFile)}, JSON.stringify({ PATH: process.env.PATH }));
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
      codexCliPath
    });

    await expect(supervisor.start()).resolves.toMatchObject({
      state: "running",
      url: "http://127.0.0.1:4310",
      port: 4310
    });
    const environment = JSON.parse(await readFile(environmentFile, "utf8")) as { PATH: string };
    expect(environment.PATH.split(":")[0]).toBe(codexBinDirectory);
    await supervisor.stop();
    expect(supervisor.getSnapshot().state).toBe("stopped");
  });
});
