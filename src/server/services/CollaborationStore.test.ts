import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationStore } from "./CollaborationStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "codex-manage-collaboration-"));
  temporaryDirectories.push(directory);
  return new CollaborationStore(join(directory, "collaboration.json"));
}

describe("CollaborationStore", () => {
  it("creates and authenticates a child user with session grants", async () => {
    const store = await createStore();
    const created = await store.createChild({
      displayName: "Alex",
      localEmail: "alex@local",
      password: "secret-pass"
    });

    expect(created.collaborator.role).toBe("child");
    expect(await store.authenticateChild(created.collaborator.id, "secret-pass")).toMatchObject({
      id: created.collaborator.id,
      displayName: "Alex",
      role: "child"
    });
    expect(await store.authenticateChild(created.collaborator.id, "wrong-pass")).toBeNull();

    await store.replaceGrants(created.collaborator.id, ["session-a", "session-a", "session-b"]);
    expect(await store.canAccessSession(created.collaborator.id, "session-a")).toBe(true);
    expect(await store.canAccessSession(created.collaborator.id, "session-c")).toBe(false);
    expect(await store.filterSessions(created.collaborator.id, [
      { id: "session-a", sessionId: "thread-a" },
      { id: "session-c", sessionId: "thread-c" }
    ])).toEqual([{ id: "session-a", sessionId: "thread-a" }]);
  });

  it("revokes access immediately when a child is disabled", async () => {
    const store = await createStore();
    const created = await store.createChild({
      displayName: "Taylor",
      localEmail: "taylor@local",
      password: "secret-pass"
    });

    await store.replaceGrants(created.collaborator.id, ["session-a"]);
    expect(await store.authenticateChild(created.collaborator.id, "secret-pass")).not.toBeNull();
    await store.setChildActive(created.collaborator.id, false);
    expect(await store.authenticateChild(created.collaborator.id, "secret-pass")).toBeNull();
    expect(await store.canAccessSession(created.collaborator.id, "session-a")).toBe(false);
  });
});
