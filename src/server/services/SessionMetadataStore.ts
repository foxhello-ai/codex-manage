import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionMetadata = {
  remarkTitle: string | null;
};

type MetadataFile = {
  sessions?: Record<string, Partial<SessionMetadata> | undefined>;
};

export class SessionMetadataStore {
  constructor(private readonly filePath: string) {}

  async get(sessionId: string): Promise<SessionMetadata> {
    const data = await this.read();
    return normalizeMetadata(data.sessions?.[sessionId]);
  }

  async getAll(): Promise<Record<string, SessionMetadata>> {
    const data = await this.read();
    const sessions: Record<string, SessionMetadata> = {};

    for (const [sessionId, metadata] of Object.entries(data.sessions ?? {})) {
      sessions[sessionId] = normalizeMetadata(metadata);
    }

    return sessions;
  }

  async update(sessionId: string, metadata: SessionMetadata): Promise<SessionMetadata> {
    const data = await this.read();
    const next = normalizeMetadata(metadata);
    const sessions = { ...(data.sessions ?? {}) };

    if (next.remarkTitle) {
      sessions[sessionId] = next;
    } else {
      sessions[sessionId] = { remarkTitle: null };
    }

    await this.write({ sessions });
    return next;
  }

  private async read(): Promise<MetadataFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as MetadataFile;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async write(data: MetadataFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeMetadata(value: Partial<SessionMetadata> | undefined): SessionMetadata {
  const remarkTitle = typeof value?.remarkTitle === "string" ? value.remarkTitle.trim() : "";
  return {
    remarkTitle: remarkTitle.length > 0 ? remarkTitle : null
  };
}
