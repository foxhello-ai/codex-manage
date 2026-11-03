import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexConfigWatcher, resolveCodexConfigDirectory } from "./CodexConfigWatcher";

describe("CodexConfigWatcher", () => {
  it("ignores desktop UI state and Manage outbox updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-config-watcher-"));
    const watcher = new CodexConfigWatcher({ directory, onChange: () => { throw Error("unexpected reload"); } });
    try {
      writeFileSync(join(directory, "config.toml"), "model = 'a'\n");
      watcher.start();
      writeFileSync(join(directory, ".codex-global-state.json"), "{}");
      writeFileSync(join(directory, "session-metadata.json.deliveries.json"), "[]");
      expect(watcher.checkNow()).toBe(false);
    } finally { watcher.stop(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("resolves CODEX_HOME before the default home directory", () => {
    expect(resolveCodexConfigDirectory({ CODEX_HOME: "/custom/codex" }, "/home/user")).toBe("/custom/codex");
  });

  it("detects Codex config changes from toml and json files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-config-watcher-"));
    const changes: string[] = [];
    const watcher = new CodexConfigWatcher({
      directory,
      debounceMs: 1,
      pollIntervalMs: 60_000,
      onChange: (change) => changes.push(change.signature)
    });

    try {
      writeFileSync(join(directory, "config.toml"), "model = 'a'\n");
      watcher.start();
      writeFileSync(join(directory, "provider.json"), "{\"name\":\"b\"}\n");

      expect(watcher.checkNow()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(changes).toHaveLength(1);
    } finally {
      watcher.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
