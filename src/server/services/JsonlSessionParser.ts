import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export type SessionCommand = {
  id: string;
  callId: string;
  turnId: string | null;
  timestamp: string | null;
  status: "completed" | "running";
  cmd: string;
  workdir: string;
  sandboxPermissions: string | null;
  justification: string | null;
  prefixRule: string[] | null;
  tty: boolean | null;
  yieldTimeMs: number | null;
  maxOutputTokens: number | null;
  output: string | null;
  outputLength: number;
};

export type SessionCommandDiagnostics = {
  scannedFiles: number;
  parsedLines: number;
  parseErrors: number;
  matchedSessionFile: boolean;
};

export type SessionCommandsResult = {
  commands: SessionCommand[];
  diagnostics: SessionCommandDiagnostics;
};

export type HistoricalModelState = {
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  updatedAt: string | null;
};

export type HistoricalModelStateResult = {
  state: HistoricalModelState;
  diagnostics: SessionCommandDiagnostics;
};

type JsonlRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

type PendingCommand = Omit<SessionCommand, "status" | "output" | "outputLength">;

type CommandOutput = {
  output: string;
};

type ParsedCommandFile = {
  sessionIds: Set<string>;
  commands: SessionCommand[];
  parsedLines: number;
  parseErrors: number;
};

type ParsedModelFile = {
  sessionIds: Set<string>;
  state: HistoricalModelState;
  parsedLines: number;
  parseErrors: number;
};

type FileCacheEntry<T> = {
  size: number;
  mtimeMs: number;
  value: T;
};

type ResolvedSessionFiles = {
  files: string[];
  scannedFiles: number;
};

const MAX_COMMAND_CACHE_FILES = 3;
const MAX_MODEL_CACHE_FILES = 100;
const MAX_HEADER_CACHE_FILES = 1_000;
const MAX_HEADER_LINES = 20;

export class JsonlSessionParser {
  private indexed = false;
  private indexPromise: Promise<void> | null = null;
  private readonly files = new Set<string>();
  private readonly sessionFiles = new Map<string, Set<string>>();
  private readonly headerCache = new Map<string, FileCacheEntry<Set<string>>>();
  private readonly commandCache = new Map<string, FileCacheEntry<ParsedCommandFile>>();
  private readonly modelCache = new Map<string, FileCacheEntry<ParsedModelFile>>();
  private readonly commandParsePromises = new Map<string, Promise<ParsedCommandFile>>();
  private readonly modelParsePromises = new Map<string, Promise<ParsedModelFile>>();

  constructor(private readonly sessionsDir: string) {}

  async listCommands(sessionId: string): Promise<SessionCommandsResult> {
    const resolved = await this.resolveSessionFiles(sessionId);
    const diagnostics = createDiagnostics(resolved.scannedFiles, resolved.files.length > 0);
    const allCommands: SessionCommand[] = [];

    for (const file of resolved.files) {
      const parsed = await this.readCommandFile(file);
      diagnostics.parsedLines += parsed.parsedLines;
      diagnostics.parseErrors += parsed.parseErrors;
      allCommands.push(...parsed.commands);
    }

    return {
      commands: allCommands.sort((left, right) => compareNullableString(left.timestamp, right.timestamp)),
      diagnostics
    };
  }

  async readModelState(sessionId: string): Promise<HistoricalModelStateResult> {
    const resolved = await this.resolveSessionFiles(sessionId);
    const diagnostics = createDiagnostics(resolved.scannedFiles, resolved.files.length > 0);
    const state = emptyModelState();

    for (const file of resolved.files) {
      const parsed = await this.readModelFile(file);
      diagnostics.parsedLines += parsed.parsedLines;
      diagnostics.parseErrors += parsed.parseErrors;
      if (parsed.state.model !== null) state.model = parsed.state.model;
      if (parsed.state.modelProvider !== null) state.modelProvider = parsed.state.modelProvider;
      if (parsed.state.reasoningEffort !== null) state.reasoningEffort = parsed.state.reasoningEffort;
      if (parsed.state.updatedAt !== null) state.updatedAt = parsed.state.updatedAt;
    }

    return { state, diagnostics };
  }

  private async resolveSessionFiles(sessionId: string): Promise<ResolvedSessionFiles> {
    const hadIndex = this.indexed;
    await this.ensureIndex();
    let matches = this.sessionFiles.get(sessionId);
    if (matches?.size) return { files: [...matches].sort(), scannedFiles: matches.size };

    if (hadIndex) {
      await this.refreshIndex();
      matches = this.sessionFiles.get(sessionId);
      if (matches?.size) return { files: [...matches].sort(), scannedFiles: matches.size };
    }

    let scannedFiles = 0;
    for (const file of this.files) {
      scannedFiles += 1;
      const sessionIds = await this.readHeaderSessionIds(file);
      this.indexFile(file, sessionIds);
    }

    matches = this.sessionFiles.get(sessionId);
    return {
      files: matches ? [...matches].sort() : [],
      scannedFiles
    };
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    await this.refreshIndex();
  }

  private async refreshIndex(): Promise<void> {
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = this.rebuildIndex().finally(() => {
      this.indexPromise = null;
    });
    return this.indexPromise;
  }

  private async rebuildIndex(): Promise<void> {
    const files = (await this.walk(this.sessionsDir)).sort();
    const currentFiles = new Set(files);
    this.files.clear();
    this.sessionFiles.clear();

    for (const file of files) {
      this.files.add(file);
      const filenameSessionId = readSessionIdFromFilename(file);
      if (filenameSessionId) this.indexFile(file, new Set([filenameSessionId]));
      const cachedHeader = this.headerCache.get(file);
      if (cachedHeader) this.indexFile(file, cachedHeader.value);
    }

    this.deleteMissingCacheEntries(this.headerCache, currentFiles);
    this.deleteMissingCacheEntries(this.commandCache, currentFiles);
    this.deleteMissingCacheEntries(this.modelCache, currentFiles);
    this.indexed = true;
  }

  private indexFile(file: string, sessionIds: Set<string>): void {
    for (const sessionId of sessionIds) {
      const indexedFiles = this.sessionFiles.get(sessionId) ?? new Set<string>();
      indexedFiles.add(file);
      this.sessionFiles.set(sessionId, indexedFiles);
    }
  }

  private deleteMissingCacheEntries<T>(cache: Map<string, T>, currentFiles: Set<string>): void {
    for (const file of cache.keys()) {
      if (!currentFiles.has(file)) cache.delete(file);
    }
  }

  private async readHeaderSessionIds(filePath: string): Promise<Set<string>> {
    const signature = await readFileSignature(filePath);
    if (!signature) return new Set();
    const cached = this.headerCache.get(filePath);
    if (cached && sameSignature(cached, signature)) return cached.value;

    const sessionIds = new Set<string>();
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineCount = 0;

    try {
      for await (const line of lines) {
        lineCount += 1;
        let record: JsonlRecord;
        try {
          record = JSON.parse(line) as JsonlRecord;
        } catch {
          if (lineCount >= MAX_HEADER_LINES) break;
          continue;
        }

        if (readString(record.type) === "session_meta") {
          collectSessionIds(sessionIds, asRecord(record.payload));
          break;
        }
        if (lineCount >= MAX_HEADER_LINES) break;
      }
    } finally {
      lines.close();
      input.destroy();
    }

    this.remember(this.headerCache, filePath, { ...signature, value: sessionIds }, MAX_HEADER_CACHE_FILES);
    return sessionIds;
  }

  private async readCommandFile(filePath: string): Promise<ParsedCommandFile> {
    const signature = await readFileSignature(filePath);
    if (!signature) return emptyCommandFile();
    const cached = this.commandCache.get(filePath);
    if (cached && sameSignature(cached, signature)) {
      this.touch(this.commandCache, filePath, cached);
      return cached.value;
    }

    const parseKey = `${filePath}:${signature.size}:${signature.mtimeMs}`;
    const running = this.commandParsePromises.get(parseKey);
    if (running) return running;

    const promise = this.parseCommandFile(filePath).then((value) => {
      this.remember(this.commandCache, filePath, { ...signature, value }, MAX_COMMAND_CACHE_FILES);
      return value;
    }).finally(() => {
      this.commandParsePromises.delete(parseKey);
    });
    this.commandParsePromises.set(parseKey, promise);
    return promise;
  }

  private async parseCommandFile(filePath: string): Promise<ParsedCommandFile> {
    const sessionIds = new Set<string>();
    const commands = new Map<string, PendingCommand>();
    const outputs = new Map<string, CommandOutput>();
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let parsedLines = 0;
    let parseErrors = 0;

    try {
      for await (const line of lines) {
        if (!line) continue;
        let record: JsonlRecord;
        try {
          record = JSON.parse(line) as JsonlRecord;
          parsedLines += 1;
        } catch {
          parseErrors += 1;
          continue;
        }
        applyCommandRecord(record, sessionIds, commands, outputs);
      }
    } finally {
      lines.close();
      input.destroy();
    }

    return {
      sessionIds,
      commands: [...commands.values()].map((command) => {
        const output = outputs.get(command.callId)?.output ?? null;
        return {
          ...command,
          status: output === null ? "running" : "completed",
          output,
          outputLength: output?.length ?? 0
        } satisfies SessionCommand;
      }),
      parsedLines,
      parseErrors
    };
  }

  private async readModelFile(filePath: string): Promise<ParsedModelFile> {
    const signature = await readFileSignature(filePath);
    if (!signature) return emptyModelFile();
    const cached = this.modelCache.get(filePath);
    if (cached && sameSignature(cached, signature)) {
      this.touch(this.modelCache, filePath, cached);
      return cached.value;
    }

    const parseKey = `${filePath}:${signature.size}:${signature.mtimeMs}`;
    const running = this.modelParsePromises.get(parseKey);
    if (running) return running;

    const promise = this.parseModelFile(filePath).then((value) => {
      this.remember(this.modelCache, filePath, { ...signature, value }, MAX_MODEL_CACHE_FILES);
      return value;
    }).finally(() => {
      this.modelParsePromises.delete(parseKey);
    });
    this.modelParsePromises.set(parseKey, promise);
    return promise;
  }

  private async parseModelFile(filePath: string): Promise<ParsedModelFile> {
    const sessionIds = new Set<string>();
    const state = emptyModelState();
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let parsedLines = 0;
    let parseErrors = 0;

    try {
      for await (const line of lines) {
        if (!line) continue;
        let record: JsonlRecord;
        try {
          record = JSON.parse(line) as JsonlRecord;
          parsedLines += 1;
        } catch {
          parseErrors += 1;
          continue;
        }
        applyModelRecord(record, sessionIds, state);
      }
    } finally {
      lines.close();
      input.destroy();
    }

    return { sessionIds, state, parsedLines, parseErrors };
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      cache.delete(oldestKey);
    }
  }

  private touch<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
  }

  private async walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }

    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return this.walk(path);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return [path];
      return [];
    }));
    return nested.flat();
  }
}

function applyCommandRecord(
  record: JsonlRecord,
  sessionIds: Set<string>,
  commands: Map<string, PendingCommand>,
  outputs: Map<string, CommandOutput>
): void {
  const payload = asRecord(record.payload);
  const recordType = readString(record.type);
  const payloadType = readString(payload.type);

  if (recordType === "session_meta") collectSessionIds(sessionIds, payload);
  if (recordType !== "response_item") return;

  if (payloadType === "function_call" && readString(payload.name) === "exec_command") {
    const callId = readString(payload.call_id);
    if (!callId) return;
    const args = parseArguments(payload.arguments);
    commands.set(callId, {
      id: callId,
      callId,
      turnId: readTurnId(payload),
      timestamp: readString(record.timestamp),
      cmd: readString(args?.cmd) ?? "",
      workdir: readString(args?.workdir) ?? "",
      sandboxPermissions: readString(args?.sandbox_permissions),
      justification: readString(args?.justification),
      prefixRule: readStringArray(args?.prefix_rule),
      tty: readBoolean(args?.tty),
      yieldTimeMs: readNumber(args?.yield_time_ms),
      maxOutputTokens: readNumber(args?.max_output_tokens)
    });
  }

  if (payloadType === "function_call_output") {
    const callId = readString(payload.call_id);
    const output = readStringAllowEmpty(payload.output);
    if (callId && output !== null) outputs.set(callId, { output });
  }
}

function applyModelRecord(record: JsonlRecord, sessionIds: Set<string>, state: HistoricalModelState): void {
  const payload = asRecord(record.payload);
  const recordType = readString(record.type);

  if (recordType === "session_meta") {
    collectSessionIds(sessionIds, payload);
    applyModelValues(state, {
      modelProvider: readString(payload.model_provider) ?? readString(payload.modelProvider),
      timestamp: readString(record.timestamp)
    });
  }

  if (recordType === "turn_context") {
    const collaborationSettings = asRecord(asRecord(payload.collaboration_mode).settings);
    applyModelValues(state, {
      model: readString(collaborationSettings.model) ?? readString(payload.model),
      modelProvider: readString(payload.model_provider) ?? readString(payload.modelProvider),
      reasoningEffort:
        readString(collaborationSettings.reasoning_effort)
        ?? readString(collaborationSettings.reasoningEffort)
        ?? readString(payload.reasoning_effort)
        ?? readString(payload.reasoningEffort),
      timestamp: readString(record.timestamp)
    });
  }

  if (recordType === "event_msg" && readString(payload.type) === "thread_settings_applied") {
    const settings = {
      ...asRecord(payload.thread_settings),
      ...asRecord(payload.threadSettings)
    };
    applyModelValues(state, {
      model: readString(settings.model) ?? readString(payload.model),
      modelProvider:
        readString(settings.model_provider)
        ?? readString(settings.modelProvider)
        ?? readString(payload.model_provider)
        ?? readString(payload.modelProvider),
      reasoningEffort:
        readString(settings.reasoning_effort)
        ?? readString(settings.reasoningEffort)
        ?? readString(settings.effort)
        ?? readString(payload.reasoning_effort)
        ?? readString(payload.reasoningEffort)
        ?? readString(payload.effort),
      timestamp: readString(record.timestamp)
    });
  }
}

function collectSessionIds(sessionIds: Set<string>, payload: Record<string, unknown>): void {
  for (const value of [payload.id, payload.session_id]) {
    const sessionId = readString(value);
    if (sessionId) sessionIds.add(sessionId);
  }
}

function createDiagnostics(scannedFiles: number, matchedSessionFile: boolean): SessionCommandDiagnostics {
  return {
    scannedFiles,
    parsedLines: 0,
    parseErrors: 0,
    matchedSessionFile
  };
}

function emptyCommandFile(): ParsedCommandFile {
  return { sessionIds: new Set(), commands: [], parsedLines: 0, parseErrors: 0 };
}

function emptyModelFile(): ParsedModelFile {
  return { sessionIds: new Set(), state: emptyModelState(), parsedLines: 0, parseErrors: 0 };
}

function emptyModelState(): HistoricalModelState {
  return {
    model: null,
    modelProvider: null,
    reasoningEffort: null,
    updatedAt: null
  };
}

async function readFileSignature(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const result = await stat(filePath);
    return { size: result.size, mtimeMs: result.mtimeMs };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function sameSignature(entry: { size: number; mtimeMs: number }, signature: { size: number; mtimeMs: number }): boolean {
  return entry.size === signature.size && entry.mtimeMs === signature.mtimeMs;
}

function readSessionIdFromFilename(filePath: string): string | null {
  const match = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function applyModelValues(
  state: HistoricalModelState,
  values: Partial<Omit<HistoricalModelState, "updatedAt">> & { timestamp?: string | null }
): void {
  let changed = false;
  if (values.model) {
    state.model = values.model;
    changed = true;
  }
  if (values.modelProvider) {
    state.modelProvider = values.modelProvider;
    changed = true;
  }
  if (values.reasoningEffort) {
    state.reasoningEffort = values.reasoningEffort;
    changed = true;
  }
  if (changed && values.timestamp) state.updatedAt = values.timestamp;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTurnId(payload: Record<string, unknown>): string | null {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object") return null;
  return readString((metadata as Record<string, unknown>).turn_id);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringAllowEmpty(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}
