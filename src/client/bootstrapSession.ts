import type { UserIdentity, UserSession } from "../shared/models";

const BOOTSTRAP_SESSION_KEY = "codex-manage-bootstrap-session-v1";
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;
type StorageRemover = Pick<Storage, "removeItem">;

export function readBootstrapSession(storage?: StorageReader): UserSession | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(BOOTSTRAP_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserSession> & { user?: unknown };
    if (parsed.authenticated !== true || !isUserIdentity(parsed.user)) return null;
    return {
      authenticated: true,
      defaultPassword: parsed.defaultPassword === true,
      user: parsed.user
    };
  } catch {
    return null;
  }
}

export function writeBootstrapSession(session: UserSession, storage?: StorageWriter): void {
  if (!session.authenticated || !session.user) return;
  try {
    (storage ?? window.localStorage).setItem(BOOTSTRAP_SESSION_KEY, JSON.stringify({
      authenticated: true,
      defaultPassword: session.defaultPassword,
      user: session.user
    }));
  } catch {
    // Local storage can be unavailable in private browsing contexts.
  }
}

export function clearBootstrapSession(storage?: StorageRemover): void {
  try {
    (storage ?? window.localStorage).removeItem(BOOTSTRAP_SESSION_KEY);
  } catch {
    // Local storage can be unavailable in private browsing contexts.
  }
}

function isUserIdentity(value: unknown): value is UserIdentity {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<UserIdentity>;
  return typeof user.id === "string"
    && (user.role === "owner" || user.role === "child")
    && typeof user.displayName === "string"
    && (typeof user.localEmail === "string" || user.localEmail === null)
    && typeof user.active === "boolean"
    && (typeof user.ownerUserId === "string" || user.ownerUserId === null);
}
