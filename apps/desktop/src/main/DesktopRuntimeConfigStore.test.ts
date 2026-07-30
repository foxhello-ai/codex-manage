import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopRuntimeConfigStore } from "./DesktopRuntimeConfigStore";

describe("DesktopRuntimeConfigStore", () => {
  it("persists and normalizes desktop runtime config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-runtime-config-"));
    const store = new DesktopRuntimeConfigStore(join(directory, "config.json"));

    store.save({
      schemaVersion: 1,
      apiBaseUrl: "https://codex-api.example.com/",
      updateFeedUrl: "https://codex-api.example.com/updates/stable/",
      managedDomainSuffixes: ["*.Example.com"],
      configTtlSeconds: 30,
      generatedAt: "2026-07-30T00:00:00.000Z",
      fetchedAt: "2026-07-30T00:00:01.000Z",
      sourceBaseUrl: "https://bootstrap.example.com/"
    });

    expect(store.load()).toMatchObject({
      schemaVersion: 1,
      apiBaseUrl: "https://codex-api.example.com",
      updateFeedUrl: "https://codex-api.example.com/updates/stable",
      managedDomainSuffixes: ["example.com"],
      configTtlSeconds: 60,
      sourceBaseUrl: "https://bootstrap.example.com"
    });
  });

  it("ignores invalid cached config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-runtime-config-"));
    const file = join(directory, "config.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 2 }), "utf8");

    expect(new DesktopRuntimeConfigStore(file).load()).toBeNull();
  });
});
