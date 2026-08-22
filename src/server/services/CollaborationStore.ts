import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collaborator, LoginAccount, UserIdentity } from "../../shared/models";
import { DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_NAME } from "../config";

export const OWNER_USER_ID = "owner";

type StoredChildUser = {
  id: string;
  ownerUserId: string;
  displayName: string;
  localEmail: string;
  passwordHash: string;
  passwordSalt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type CollaborationFile = {
  version?: number;
  users?: Record<string, StoredChildUser | undefined>;
  grants?: Record<string, string[] | undefined>;
  [key: string]: unknown;
};

export type CreateChildInput = {
  displayName: string;
  localEmail: string;
  password?: string;
};

export type CreateChildResult = {
  collaborator: Collaborator;
  initialPassword: string;
};

export type OwnerIdentityOptions = {
  displayName?: string;
  localEmail?: string;
};

export class CollaborationStore {
  private writeChain: Promise<void> = Promise.resolve();
  private readonly ownerDisplayName: string;
  private readonly ownerEmail: string;

  constructor(private readonly filePath: string, owner: OwnerIdentityOptions = {}) {
    this.ownerDisplayName = owner.displayName?.trim() || DEFAULT_OWNER_NAME;
    this.ownerEmail = owner.localEmail?.trim() || DEFAULT_OWNER_EMAIL;
  }

  ownerIdentity(): UserIdentity {
    return {
      id: OWNER_USER_ID,
      role: "owner",
      displayName: this.ownerDisplayName,
      localEmail: this.ownerEmail,
      active: true,
      ownerUserId: null
    };
  }

  async resolveIdentity(userId: string): Promise<UserIdentity | null> {
    if (userId === OWNER_USER_ID || userId === "authenticated") return this.ownerIdentity();
    const data = await this.read();
    const child = data.users?.[userId];
    if (!child || child.active !== true) return null;
    return this.toIdentity(child);
  }

  async listLoginAccounts(): Promise<LoginAccount[]> {
    const data = await this.read();
    return Object.values(data.users ?? {})
      .filter((user): user is StoredChildUser => Boolean(user && user.active))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((user) => ({
        id: user.id,
        role: "child" as const,
        displayName: user.displayName,
        localEmail: user.localEmail
      }));
  }

  async authenticateChild(userId: string, password: string): Promise<UserIdentity | null> {
    const data = await this.read();
    const child = data.users?.[userId];
    if (!child || child.active !== true || !verifyPassword(password, child.passwordSalt, child.passwordHash)) return null;
    return this.toIdentity(child);
  }

  async listCollaborators(): Promise<Collaborator[]> {
    const data = await this.read();
    return Object.values(data.users ?? {})
      .filter((user): user is StoredChildUser => Boolean(user))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((user) => this.toCollaborator(user, data.grants?.[user.id] ?? []));
  }

  async createChild(input: CreateChildInput): Promise<CreateChildResult> {
    const displayName = input.displayName.trim();
    const localEmail = input.localEmail.trim().toLocaleLowerCase();
    if (displayName.length < 1 || displayName.length > 80) throw new Error("DISPLAY_NAME_INVALID");
    if (!/^\S+@\S+$/.test(localEmail) || localEmail.length > 160) throw new Error("LOCAL_EMAIL_INVALID");

    const initialPassword = input.password?.trim() || randomPassword();
    if (initialPassword.length < 8 || initialPassword.length > 200) throw new Error("PASSWORD_INVALID");

    return this.enqueue(async () => {
      const data = await this.read();
      const duplicate = Object.values(data.users ?? {}).some((user) => user?.localEmail.toLocaleLowerCase() === localEmail);
      if (duplicate) throw new Error("LOCAL_EMAIL_EXISTS");

      const now = new Date().toISOString();
      const id = `child_${randomUUID()}`;
      const { salt, hash } = hashPassword(initialPassword);
      const child: StoredChildUser = {
        id,
        ownerUserId: OWNER_USER_ID,
        displayName,
        localEmail,
        passwordHash: hash,
        passwordSalt: salt,
        active: true,
        createdAt: now,
        updatedAt: now
      };
      const users = { ...(data.users ?? {}), [id]: child };
      const grants = { ...(data.grants ?? {}), [id]: [] };
      await this.write({ ...data, version: 1, users, grants });
      return { collaborator: this.toCollaborator(child, []), initialPassword };
    });
  }

  async setChildActive(userId: string, active: boolean): Promise<Collaborator> {
    return this.enqueue(async () => {
      const data = await this.read();
      const current = data.users?.[userId];
      if (!current) throw new Error("CHILD_NOT_FOUND");
      const child = { ...current, active, updatedAt: new Date().toISOString() };
      await this.write({ ...data, users: { ...(data.users ?? {}), [userId]: child } });
      return this.toCollaborator(child, data.grants?.[userId] ?? []);
    });
  }

  async replaceGrants(userId: string, sessionIds: string[]): Promise<Collaborator> {
    return this.enqueue(async () => {
      const data = await this.read();
      const child = data.users?.[userId];
      if (!child) throw new Error("CHILD_NOT_FOUND");
      const grants = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
      await this.write({
        ...data,
        grants: { ...(data.grants ?? {}), [userId]: grants }
      });
      return this.toCollaborator(child, grants);
    });
  }

  async canAccessSession(userId: string, sessionId: string): Promise<boolean> {
    if (userId === OWNER_USER_ID || userId === "authenticated") return true;
    const identity = await this.resolveIdentity(userId);
    if (!identity || identity.role !== "child") return false;
    const data = await this.read();
    return (data.grants?.[userId] ?? []).includes(sessionId);
  }

  async filterSessions<T extends { id: string; sessionId: string }>(userId: string, sessions: T[]): Promise<T[]> {
    if (userId === OWNER_USER_ID || userId === "authenticated") return sessions;
    const data = await this.read();
    const grants = new Set(data.grants?.[userId] ?? []);
    return sessions.filter((session) => grants.has(session.id) || grants.has(session.sessionId));
  }

  async getCollaborator(userId: string): Promise<Collaborator | null> {
    const data = await this.read();
    const child = data.users?.[userId];
    return child ? this.toCollaborator(child, data.grants?.[userId] ?? []) : null;
  }

  private toIdentity(child: StoredChildUser): UserIdentity {
    return {
      id: child.id,
      role: "child",
      displayName: child.displayName,
      localEmail: child.localEmail,
      active: child.active,
      ownerUserId: child.ownerUserId
    };
  }

  private toCollaborator(child: StoredChildUser, grants: string[]): Collaborator {
    return {
      ...this.toIdentity(child),
      grants: [...new Set(grants)],
      createdAt: child.createdAt
    };
  }

  private async read(): Promise<CollaborationFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as CollaborationFile;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(data: CollaborationFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const actual = scryptSync(password, salt, 32);
    const expected = Buffer.from(expectedHash, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomPassword(): string {
  return randomBytes(9).toString("base64url");
}
