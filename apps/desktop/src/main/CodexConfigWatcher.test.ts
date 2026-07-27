import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexConfigWatcher, resolveCodexConfigDirectory } from "./CodexConfigWatcher";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CodexConfigWatcher", () => {
  it("resolves CODEX_HOME ahead of the default home directory", () => {
    expect(resolveCodexConfigDirectory({ CODEX_HOME: "/tmp/custom-codex" }, "/Users/test")).toBe("/tmp/custom-codex");
  });

  it("emits a debounced change when a Codex config file changes", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "config.toml"), "model = 'a'\n");
    const changes: string[] = [];
    const watcher = new CodexConfigWatcher({
      directory: dir,
      debounceMs: 1,
      pollIntervalMs: 60_000,
      onChange: (change) => changes.push(change.signature)
    });

    watcher.start();
    await writeFile(join(dir, "config.toml"), "model = 'b'\n");
    watcher.checkNow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    watcher.stop();

    expect(changes).toHaveLength(1);
  });

  it("ignores top-level runtime state JSON files", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "config.toml"), "model = 'a'\n");
    const watcher = new CodexConfigWatcher({
      directory: dir,
      debounceMs: 1,
      pollIntervalMs: 60_000,
      onChange: () => undefined
    });

    watcher.start();
    await writeFile(join(dir, "session-cache.json"), "{}\n");
    await writeFile(join(dir, ".codex-global-state.json"), "{}\n");
    await writeFile(join(dir, "models_cache.json"), "{}\n");
    await writeFile(join(dir, "version.json"), "{}\n");
    expect(watcher.checkNow()).toBe(false);
    watcher.stop();
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-config-watcher-"));
  tempDirs.push(dir);
  return dir;
}
