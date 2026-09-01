import { describe, expect, it } from "vitest";
import type { UserSession } from "../shared/models";
import { clearBootstrapSession, readBootstrapSession, writeBootstrapSession } from "./bootstrapSession";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

const authenticatedSession: UserSession = {
  authenticated: true,
  defaultPassword: false,
  user: {
    id: "owner",
    role: "owner",
    displayName: "Owner",
    localEmail: "owner@local",
    active: true,
    ownerUserId: null
  }
};

describe("bootstrap session cache", () => {
  it("stores only the authenticated identity and restores it", () => {
    const storage = createStorage();
    writeBootstrapSession(authenticatedSession, storage);

    expect(readBootstrapSession(storage)).toEqual(authenticatedSession);
  });

  it("ignores malformed or unauthenticated values", () => {
    const storage = createStorage();
    storage.setItem("codex-manage-bootstrap-session-v1", JSON.stringify({ authenticated: false }));
    expect(readBootstrapSession(storage)).toBeNull();

    storage.setItem("codex-manage-bootstrap-session-v1", "not-json");
    expect(readBootstrapSession(storage)).toBeNull();
  });

  it("clears the cached identity", () => {
    const storage = createStorage();
    writeBootstrapSession(authenticatedSession, storage);
    clearBootstrapSession(storage);
    expect(readBootstrapSession(storage)).toBeNull();
  });
});
