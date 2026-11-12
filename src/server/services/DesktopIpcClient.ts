import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";

// Existing desktop IPC only. Never creates a router, launches the app or resumes a thread.
export class DesktopIpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private clientId = "initializing-client";
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly path: string, private readonly timeoutMs = 8000) { super(); }
  async start(): Promise<void> {
    const uid = process.getuid?.();
    const [directory, socketFile] = await Promise.all([lstat(dirname(this.path)), lstat(this.path)]);
    if (uid === undefined || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)
      || !socketFile.isSocket() || socketFile.uid !== uid || (socketFile.mode & 0o077)) throw new Error("桌面通信入口不属于当前用户或权限不正确");
    const socket = connect(this.path); this.socket = socket;
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    socket.on("data", chunk => this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("桌面连接超时")); }, this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
    const initialized = await this.request("initialize", { clientType: "codex-manage" }, 0);
    if (typeof initialized.result?.clientId !== "string") throw new Error("桌面通信初始化失败");
    this.clientId = initialized.result.clientId;
  }
  request(method: string, params: unknown, version: number, targetClientId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("桌面请求结果待确认")); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: "request", requestId, sourceClientId: this.clientId, version, method, params, targetClientId }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  follow(threadId: string, ownerId: string, following: boolean): void {
    this.write({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: this.clientId, targetClientIds: [ownerId], params: { conversationId: threadId, hostId: "local", following } });
  }
  close(): void {
    const socket = this.socket; this.socket = null;
    socket?.destroy(); this.buffer = Buffer.alloc(0);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("桌面连接已断开，提交结果待确认")); }
    this.pending.clear();
    if (socket) this.emit("disconnected");
  }
  private write(message: unknown): void {
    if (!this.socket?.writable) throw new Error("桌面连接不可用");
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length); this.socket.write(Buffer.concat([header, body]));
  }
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > 256 * 1024 * 1024) { this.close(); return; }
      if (this.buffer.length < size + 4) return;
      const body = this.buffer.subarray(4, size + 4); this.buffer = this.buffer.subarray(size + 4);
      let message: any;
      try { message = JSON.parse(body.toString("utf8")); } catch { this.close(); return; }
      if (message.type === "response") {
        const entry = this.pending.get(message.requestId);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(message.requestId); entry.resolve(message); }
      } else if (message.type === "broadcast") this.emit("broadcast", message);
    }
  }
}
