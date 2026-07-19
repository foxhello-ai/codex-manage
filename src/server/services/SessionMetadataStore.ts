import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersistedModelSelection } from "../../shared/models";

export type SessionMetadata = {
  remarkTitle: string | null;
  modelSelection: PersistedModelSelection;
};

type MetadataFile = {
  sessions?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
};

export class SessionMetadataStore {
  private writeChain: Promise<void> = Promise.resolve();

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

  update(sessionId: string, metadata: Pick<SessionMetadata, "remarkTitle">): Promise<SessionMetadata> {
    return this.updateRemarkTitle(sessionId, metadata.remarkTitle);
  }

  updateRemarkTitle(sessionId: string, remarkTitle: string | null): Promise<SessionMetadata> {
    return this.patch(sessionId, { remarkTitle });
  }

  async updateModelSelection(sessionId: string, selection: PersistedModelSelection): Promise<SessionMetadata> {
    validateModelSelection(selection);
    return await this.patch(sessionId, { modelSelection: selection });
  }

  patch(sessionId: string, patch: Partial<SessionMetadata>): Promise<SessionMetadata> {
    return this.enqueue(async () => {
      const data = await this.read();
      const sessions = { ...(data.sessions ?? {}) };
      const rawCurrent = asRecord(sessions[sessionId]);
      const current = normalizeMetadata(rawCurrent);
      const next = normalizeMetadata({
        ...rawCurrent,
        remarkTitle: patch.remarkTitle !== undefined ? patch.remarkTitle : current.remarkTitle,
        modelSelection: patch.modelSelection !== undefined ? patch.modelSelection : current.modelSelection
      });

      sessions[sessionId] = {
        ...rawCurrent,
        remarkTitle: next.remarkTitle,
        modelSelection: next.modelSelection
      };

      await this.write({ ...data, sessions });
      return next;
    });
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

export function defaultModelSelection(): PersistedModelSelection {
  return {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    updatedAt: null
  };
}

function normalizeMetadata(value: unknown): SessionMetadata {
  const record = asRecord(value);
  const remarkTitle = typeof record.remarkTitle === "string" ? record.remarkTitle.trim() : "";
  return {
    remarkTitle: remarkTitle.length > 0 ? remarkTitle : null,
    modelSelection: normalizeModelSelection(record.modelSelection)
  };
}

function normalizeModelSelection(value: unknown): PersistedModelSelection {
  const record = asRecord(value);
  const mode = record.mode === "override" ? "override" : "follow_session";
  const preferredModel = readTrimmedString(record.preferredModel);
  const preferredReasoningEffort = readTrimmedString(record.preferredReasoningEffort);
  const updatedAt = readTrimmedString(record.updatedAt);

  if (mode !== "override" || !preferredModel) {
    return {
      mode: "follow_session",
      preferredModel: null,
      preferredReasoningEffort: null,
      updatedAt
    };
  }

  return {
    mode,
    preferredModel,
    preferredReasoningEffort,
    updatedAt
  };
}

function validateModelSelection(selection: PersistedModelSelection): void {
  if (selection.mode === "override" && !selection.preferredModel?.trim()) {
    throw new Error("override model selection requires a model");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
