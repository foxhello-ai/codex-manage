import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexLocator } from "./CodexLocator";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexLocator", () => {
  it("finds an NVM Codex CLI and adds its Node directory to PATH", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "codex-manage-locator-"));
    directories.push(homeDirectory);
    const binDirectory = join(homeDirectory, ".nvm", "versions", "node", "v22.22.0", "bin");
    const codexPath = join(binDirectory, "codex");
    await mkdir(binDirectory, { recursive: true });
    await symlink(process.execPath, join(binDirectory, "node"));
    await writeFile(codexPath, "#!/usr/bin/env node\nprocess.stdout.write('codex-cli 0.142.0\\n');\n");
    await chmod(codexPath, 0o755);

    const locator = new CodexLocator({
      platform: "darwin",
      homeDirectory,
      environment: { PATH: "/usr/bin:/bin" }
    });

    await expect(locator.locate()).resolves.toEqual({
      available: true,
      path: codexPath,
      version: "codex-cli 0.142.0",
      error: null
    });
  });
});
