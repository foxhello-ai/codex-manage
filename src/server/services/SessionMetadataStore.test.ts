import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionMetadataStore } from "./SessionMetadataStore";

describe("SessionMetadataStore", () => {
  it("stores, trims, and clears remark titles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-manage-metadata-"));
    const file = join(dir, "session-metadata.json");
    const store = new SessionMetadataStore(file);

    await expect(store.get("thread-1")).resolves.toEqual({ remarkTitle: null });
    await expect(store.update("thread-1", { remarkTitle: "  备注标题  " })).resolves.toEqual({ remarkTitle: "备注标题" });
    await expect(store.getAll()).resolves.toEqual({ "thread-1": { remarkTitle: "备注标题" } });
    await expect(store.update("thread-1", { remarkTitle: "" })).resolves.toEqual({ remarkTitle: null });

    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({ sessions: { "thread-1": { remarkTitle: null } } });
  });
});
