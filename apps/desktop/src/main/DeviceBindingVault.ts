import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";

export type DeviceBinding = {
  userId: string;
  deviceId: string;
  deviceCredential: string;
};

type DeviceBindingPayload = {
  bindings: Record<string, Omit<DeviceBinding, "userId">>;
};

export class DeviceBindingVault {
  constructor(private readonly file: string) {}

  load(userId: string): DeviceBinding | null {
    const binding = this.read().bindings[userId];
    if (!binding?.deviceId || !binding.deviceCredential) return null;
    return { userId, ...binding };
  }

  save(binding: DeviceBinding): void {
    const payload = this.read();
    payload.bindings[binding.userId] = {
      deviceId: binding.deviceId,
      deviceCredential: binding.deviceCredential
    };
    this.write(payload);
  }

  clear(userId: string): void {
    const payload = this.read();
    if (!payload.bindings[userId]) return;
    delete payload.bindings[userId];
    if (Object.keys(payload.bindings).length === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    this.write(payload);
  }

  private read(): DeviceBindingPayload {
    try {
      const payload = JSON.parse(readFileSync(this.file, "utf8")) as { encrypted?: unknown };
      if (typeof payload.encrypted !== "string" || !safeStorage.isEncryptionAvailable()) {
        return { bindings: {} };
      }
      const plaintext = safeStorage.decryptString(Buffer.from(payload.encrypted, "base64"));
      const parsed = JSON.parse(plaintext) as Partial<DeviceBindingPayload>;
      return parsed.bindings && typeof parsed.bindings === "object"
        ? { bindings: parsed.bindings }
        : { bindings: {} };
    } catch {
      return { bindings: {} };
    }
  }

  private write(payload: DeviceBindingPayload): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("操作系统安全存储当前不可用，无法保存设备绑定");
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString("base64");
    writeFileSync(this.file, JSON.stringify({ encrypted }), { encoding: "utf8", mode: 0o600 });
  }
}
