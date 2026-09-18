import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/models";
import { TaskStore } from "./TaskStore";

function session(id: string, updatedAt: string): SessionSummary {
  return { id, sessionId: id, title: `会话 ${id}`, defaultTitle: `会话 ${id}`, remarkTitle: null, summary: "摘要", workspace: "/workspace", createdAt: updatedAt, updatedAt, status: "history", cliVersion: null, source: null };
}

describe("TaskStore", () => {
  it("persists tasks and builds details from session summaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-task-"));
    const store = new TaskStore(join(directory, "tasks.json"));
    const task = await store.create("FOX-28");
    await store.addSession(task.id, "session-1");
    await store.update(task.id, { pinned: true });

    const detail = await store.get(task.id, [session("session-1", "2026-09-18T01:00:00.000Z")]);
    expect(detail).toMatchObject({ name: "FOX-28", pinned: true, sessionCount: 1, recentSessionId: "session-1", sessions: [{ id: "session-1" }] });
    expect(JSON.parse(await readFile(join(directory, "tasks.json"), "utf8")).tasks[task.id].sessionIds).toEqual(["session-1"]);
  });
});
