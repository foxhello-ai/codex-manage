import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionSummary, TaskDetail, TaskSummary } from "../../shared/models";

type StoredTask = {
  id: string;
  name: string;
  pinned: boolean;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
};

type TaskFile = { tasks?: Record<string, StoredTask> };

export class TaskStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(sessions: SessionSummary[]): Promise<TaskSummary[]> {
    const data = await this.read();
    return Object.values(data.tasks ?? {})
      .map((task) => summarizeTask(task, sessions))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string, sessions: SessionSummary[]): Promise<TaskDetail | null> {
    const task = (await this.read()).tasks?.[id];
    if (!task) return null;
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    return { ...summarizeTask(task, sessions), sessions: task.sessionIds.map((sessionId) => sessionMap.get(sessionId)).filter((session): session is SessionSummary => Boolean(session)) };
  }

  async create(name: string): Promise<StoredTask> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("任务名称不能为空");
    return this.enqueue(async () => {
      const data = await this.read();
      const now = new Date().toISOString();
      const task: StoredTask = { id: randomUUID(), name: trimmed, pinned: false, sessionIds: [], createdAt: now, updatedAt: now };
      await this.write({ ...data, tasks: { ...(data.tasks ?? {}), [task.id]: task } });
      return task;
    });
  }

  async update(id: string, patch: { name?: string; pinned?: boolean }): Promise<StoredTask> {
    return this.enqueue(async () => {
      const data = await this.read();
      const current = data.tasks?.[id];
      if (!current) throw new Error("Task not found");
      const next: StoredTask = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        updatedAt: new Date().toISOString()
      };
      if (!next.name) throw new Error("任务名称不能为空");
      await this.write({ ...data, tasks: { ...(data.tasks ?? {}), [id]: next } });
      return next;
    });
  }

  async addSession(taskId: string, sessionId: string): Promise<StoredTask> {
    return this.enqueue(async () => {
      const data = await this.read();
      const current = data.tasks?.[taskId];
      if (!current) throw new Error("Task not found");
      const next = current.sessionIds.includes(sessionId) ? current : { ...current, sessionIds: [...current.sessionIds, sessionId], updatedAt: new Date().toISOString() };
      await this.write({ ...data, tasks: { ...(data.tasks ?? {}), [taskId]: next } });
      return next;
    });
  }

  async taskForSession(sessionId: string): Promise<StoredTask | null> {
    const data = await this.read();
    return Object.values(data.tasks ?? {}).find((task) => task.sessionIds.includes(sessionId)) ?? null;
  }

  private async read(): Promise<TaskFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? parsed as TaskFile : {};
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(data: TaskFile): Promise<void> {
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

function summarizeTask(task: StoredTask, sessions: SessionSummary[]): TaskSummary {
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const taskSessions = task.sessionIds.map((id) => sessionMap.get(id)).filter((session): session is SessionSummary => Boolean(session));
  const recent = [...taskSessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  return {
    id: task.id,
    name: task.name,
    pinned: task.pinned,
    sessionIds: [...task.sessionIds],
    sessionCount: task.sessionIds.length,
    recentSessionId: recent?.id ?? null,
    recentSessionTitle: recent?.title ?? null,
    updatedAt: task.updatedAt
  };
}
