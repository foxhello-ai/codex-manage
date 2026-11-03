import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { QueuedDelivery } from "../../shared/models";
import { ModelDomainError, sanitizeModelError } from "../modelErrors";
import type { CodexAppServerClient } from "./CodexAppServerClient";

const Delivery = z.object({
  requestId: z.string(), threadId: z.string(), text: z.string(),
  queueId: z.string().nullable(), turnId: z.string().nullable(), itemId: z.string().nullable(),
  status: z.enum(["submitting", "queued", "observed", "completed", "failed", "unknown"]),
  createdAt: z.string(), error: z.string().nullable()
});

// Uses the same native persistent queue as `codex queue`, with a caller-owned
// clientUserMessageId so consumption can be correlated without comparing text.
export class DesktopQueueService {
  private deliveries: QueuedDelivery[] = [];
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly appServer: Pick<CodexAppServerClient, "request">, private readonly filePath: string) {}

  list(threadId: string): QueuedDelivery[] {
    return this.deliveries.filter(row => row.threadId === threadId).map(row => ({ ...row }));
  }

  async find(requestId: string): Promise<QueuedDelivery | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const row = this.deliveries.find(row => row.requestId === requestId);
      return row ? { ...row } : undefined;
    });
  }

  async hasPending(threadId: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.load();
      return this.deliveries.some(row => row.threadId === threadId && !["completed", "failed"].includes(row.status));
    });
  }

  enqueue(threadId: string, requestId: string, text: string): Promise<QueuedDelivery> {
    return this.exclusive(async () => {
      await this.load();
      const existing = this.deliveries.find(row => row.requestId === requestId);
      if (existing) {
        if (existing.threadId !== threadId || existing.text !== text) {
          throw new ModelDomainError("INPUT_REQUEST_CONFLICT", "此发送标识已用于另一条消息", 409);
        }
        if (existing.status === "failed") {
          throw new ModelDomainError("DESKTOP_QUEUE_UNAVAILABLE", existing.error ?? "原投递已失败，请到桌面核对后再发送", 409);
        }
        return { ...existing };
      }
      const row: QueuedDelivery = {
        requestId, threadId, text, queueId: null, turnId: null, itemId: null,
        status: "submitting", createdAt: new Date().toISOString(), error: null
      };
      this.deliveries.push(row);
      await this.save();
      try {
        const result = await this.appServer.request<{ queuedSubmission: { id: string; clientUserMessageId: string } }>("thread/queue/add", {
          threadId, clientUserMessageId: requestId, input: [{ type: "text", text, text_elements: [] }]
        });
        if (!result.queuedSubmission?.id || result.queuedSubmission.clientUserMessageId !== requestId) {
          throw new Error("队列返回的消息标识无法确认");
        }
        row.queueId = result.queuedSubmission.id;
        row.status = "queued";
      } catch (error) {
        row.error = sanitizeModelError(error);
        const unsupported = /method not found|unknown variant|unknown method|unsupported.*queue/i.test(row.error);
        row.status = unsupported ? "failed" : "unknown";
        await this.save();
        if (unsupported) throw new ModelDomainError("DESKTOP_QUEUE_UNAVAILABLE", "当前 Codex 版本不支持桌面会话投递，请升级兼容版本后重试", 409);
        return { ...row };
      }
      await this.save();
      return { ...row };
    });
  }

  refresh(threadId: string): Promise<QueuedDelivery[]> {
    return this.exclusive(async () => {
      await this.load();
      const pending = this.deliveries.filter(row => row.threadId === threadId && !["completed", "failed"].includes(row.status));
      if (pending.length === 0) return this.list(threadId);
      const before = JSON.stringify(pending);
      try {
        let cursor: string | null = null;
        do {
          const page: { data: Array<{ id: string; clientUserMessageId: string }>; nextCursor?: string | null } =
            await this.appServer.request("thread/queue/list", { threadId, cursor, limit: 100 });
          for (const item of page.data) {
            const row = pending.find(row => row.requestId === item.clientUserMessageId);
            if (row) { row.queueId = item.id; row.status = "queued"; row.error = null; }
          }
          cursor = page.nextCursor ?? null;
        } while (cursor);
        const unmatched = new Set(pending.map(row => row.requestId));
        cursor = null;
        do {
          const page: { data: Array<{ id: string; status: string; error?: unknown; items: Array<{ id: string; type: string; clientId?: string | null }> }>; nextCursor?: string | null } =
            await this.appServer.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "summary" });
          for (const turn of page.data) {
            for (const item of turn.items) {
              if (item.type !== "userMessage" || !item.clientId || !unmatched.has(item.clientId)) continue;
              const row = pending.find(row => row.requestId === item.clientId)!;
              row.turnId = turn.id; row.itemId = item.id; row.error = null;
              // A cold reader can report an unfinished external turn as interrupted
              // before the desktop persists task_complete. Keep observing it.
              row.status = turn.status === "completed" ? "completed"
                : turn.status === "failed" && turn.error != null ? "failed" : "observed";
              if (row.status === "failed") row.error = "桌面回合失败，请到桌面查看";
              else if (["failed", "interrupted"].includes(turn.status)) row.error = "回合状态待桌面确认，继续核对原会话";
              unmatched.delete(row.requestId);
            }
          }
          cursor = page.nextCursor ?? null;
        } while (cursor && unmatched.size);
      } catch {
        // Lack of a readable snapshot never proves delivery failed or completed.
      }
      if (JSON.stringify(pending) !== before) await this.save();
      return this.list(threadId);
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.deliveries = z.array(Delivery).parse(JSON.parse(await readFile(this.filePath, "utf8")));
      for (const row of this.deliveries) {
        if (row.status === "submitting") { row.status = "unknown"; row.error = "上次投递中断，正在核对原会话；请勿重复发送"; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.deliveries), { mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}
