import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionMetadataStore } from "./SessionMetadataStore";

describe("SessionMetadataStore", () => {
  it("stores, trims, and clears remark titles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-manage-metadata-"));
    const file = join(dir, "session-metadata.json");
    const store = new SessionMetadataStore(file);

    await expect(store.get("thread-1")).resolves.toEqual({
      remarkTitle: null,
      permissionMode: "default",
      modelSelection: {
        mode: "follow_session",
        preferredModel: null,
        preferredReasoningEffort: null,
        updatedAt: null
      }
    });
    await expect(store.update("thread-1", { remarkTitle: "  备注标题  " })).resolves.toMatchObject({ remarkTitle: "备注标题" });
    await expect(store.getAll()).resolves.toMatchObject({ "thread-1": { remarkTitle: "备注标题" } });
    await expect(store.update("thread-1", { remarkTitle: "" })).resolves.toMatchObject({ remarkTitle: null });

    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({
      sessions: {
        "thread-1": {
          remarkTitle: null,
          permissionMode: "default",
          modelSelection: {
            mode: "follow_session",
            preferredModel: null,
            preferredReasoningEffort: null,
            updatedAt: null
          }
        }
      }
    });
  });

  it("keeps remarks, model preferences, and unknown fields independent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-manage-metadata-compatible-"));
    const file = join(dir, "session-metadata.json");
    await writeFile(file, JSON.stringify({
      version: 2,
      sessions: {
        "thread-1": { remarkTitle: "旧标题", futureField: { enabled: true } }
      }
    }));
    const store = new SessionMetadataStore(file);

    await store.updateModelSelection("thread-1", {
      mode: "override",
      preferredModel: " gpt-5.6-sol ",
      preferredReasoningEffort: " high ",
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    await store.updateRemarkTitle("thread-1", "新标题");

    await expect(store.get("thread-1")).resolves.toEqual({
      remarkTitle: "新标题",
      permissionMode: "default",
      modelSelection: {
        mode: "override",
        preferredModel: "gpt-5.6-sol",
        preferredReasoningEffort: "high",
        updatedAt: "2026-07-19T00:00:00.000Z"
      }
    });

    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 2,
      sessions: {
        "thread-1": {
          remarkTitle: "新标题",
          permissionMode: "default",
          futureField: { enabled: true },
          modelSelection: { mode: "override", preferredModel: "gpt-5.6-sol" }
        }
      }
    });
  });

  it("serializes concurrent read-modify-write operations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-manage-metadata-concurrent-"));
    const file = join(dir, "session-metadata.json");
    const store = new SessionMetadataStore(file);

    await Promise.all([
      store.updateRemarkTitle("thread-1", "并发标题"),
      store.updateModelSelection("thread-1", {
        mode: "override",
        preferredModel: "gpt-5.6-sol",
        preferredReasoningEffort: null,
        updatedAt: "2026-07-19T00:00:00.000Z"
      })
    ]);

    await expect(store.get("thread-1")).resolves.toMatchObject({
      remarkTitle: "并发标题",
      permissionMode: "default",
      modelSelection: { mode: "override", preferredModel: "gpt-5.6-sol" }
    });
  });

  it("stores and restores the permission mode per session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-manage-metadata-permission-"));
    const file = join(dir, "session-metadata.json");
    const store = new SessionMetadataStore(file);

    await store.updatePermissionMode("thread-1", "full_access");

    await expect(store.get("thread-1")).resolves.toMatchObject({ permissionMode: "full_access" });
    await expect(store.getAll()).resolves.toMatchObject({
      "thread-1": { permissionMode: "full_access" }
    });
  });

  it("rejects override preferences without a model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-manage-metadata-invalid-"));
    const store = new SessionMetadataStore(join(dir, "session-metadata.json"));

    await expect(store.updateModelSelection("thread-1", {
      mode: "override",
      preferredModel: null,
      preferredReasoningEffort: null,
      updatedAt: null
    })).rejects.toThrow("requires a model");
  });
});
