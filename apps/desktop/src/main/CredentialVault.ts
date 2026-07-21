import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { CloudSession } from "./CloudClient";

export class CredentialVault {
  constructor(private readonly file: string) {}

  load(): CloudSession | null {
    try {
      const payload = JSON.parse(readFileSync(this.file, "utf8")) as { encrypted: string };
      if (!safeStorage.isEncryptionAvailable()) return null;
      const plaintext = safeStorage.decryptString(Buffer.from(payload.encrypted, "base64"));
      return JSON.parse(plaintext) as CloudSession;
    } catch {
      return null;
    }
  }

  save(session: CloudSession): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("操作系统安全存储当前不可用，无法保存登录凭证");
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(session)).toString("base64");
    writeFileSync(this.file, JSON.stringify({ encrypted }), { encoding: "utf8", mode: 0o600 });
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
