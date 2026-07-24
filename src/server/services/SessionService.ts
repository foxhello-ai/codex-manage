import type { CodexAppServerClient } from "./CodexAppServerClient";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import type { SessionModelState } from "../../shared/models";
import type { JsonlSessionParser } from "./JsonlSessionParser";
import type { ModelCatalogService } from "./ModelCatalogService";
import type { RuntimeManager } from "./RuntimeManager";
import { sanitizeModelError } from "../modelErrors";

export type SessionStatus = "history" | "starting" | "running" | "waiting_input" | "waiting_approval" | "exited" | "failed";

export type SessionSummary = {
  id: string;
  sessionId: string;
  title: string;
  defaultTitle: string;
  remarkTitle: string | null;
  summary: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  cliVersion: string | null;
  source: string | null;
};

export type SessionDetail = SessionSummary & {
  path: string | null;
  modelProvider: string | null;
  historyMode: string | null;
  modelState: SessionModelState;
  turns: SessionTurn[];
};

export type SessionTurn = {
  id: string;
  status: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  items: SessionTurnItem[];
};

export type SessionTurnItem =
  | { id: string; type: "user_message"; text: string }
  | { id: string; type: "agent_message"; text: string; phase: string | null }
  | { id: string; type: "file_change"; status: string | null; changes: SessionFileChange[] }
  | { id: string; type: "context_compaction" }
  | { id: string; type: "unknown"; rawType: string | null };

export type SessionFileChange = {
  path: string;
  kind: string | null;
  diff: string | null;
};

type ThreadListResponse = {
  data?: unknown[];
  nextCursor?: string | null;
};

type ThreadReadResponse = {
  thread?: unknown;
};

type ListSessionsParams = {
  search?: string;
  limit?: number;
};

const DEFAULT_SESSION_SCAN_LIMIT = 1000;
const SESSION_PAGE_SIZE = 100;

type MetadataStore = {
  getAll(): Promise<Record<string, { remarkTitle: string | null }>>;
  get?(sessionId: string): Promise<{
    remarkTitle: string | null;
    modelSelection: {
      mode: "follow_session" | "override";
      preferredModel: string | null;
      preferredReasoningEffort: string | null;
      updatedAt: string | null;
    };
  }>;
  update(sessionId: string, metadata: { remarkTitle: string | null }): Promise<{ remarkTitle: string | null }>;
};

export class SessionService {
  constructor(
    private readonly appServer: Pick<CodexAppServerClient, "request" | "getSnapshot">,
    private readonly metadataStore?: MetadataStore,
    private readonly jsonlParser?: Pick<JsonlSessionParser, "readModelState">,
    private readonly modelCatalog?: Pick<ModelCatalogService, "list">,
    private readonly runtimeManager?: Pick<RuntimeManager, "getRuntime">
  ) {}

  async listSessions(params: ListSessionsParams = {}): Promise<SessionSummary[]> {
    this.assertReady();

    const scanLimit = params.search ? DEFAULT_SESSION_SCAN_LIMIT : params.limit ?? DEFAULT_SESSION_SCAN_LIMIT;
    const threads: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    while (threads.length < scanLimit) {
      const response = await this.appServer.request<ThreadListResponse>("thread/list", {
        cursor,
        limit: Math.min(SESSION_PAGE_SIZE, scanLimit - threads.length),
        sortDirection: "desc",
        sortKey: "updated_at",
        archived: false,
        searchTerm: null
      });

      threads.push(...(response.data ?? []));
      cursor = readString(response.nextCursor);
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }

    const metadata = await this.readMetadata();
    const searchTerm = params.search?.trim().toLocaleLowerCase() ?? "";
    const sessions = threads
      .map((thread) => this.toSummary(thread, metadata))
      .filter((session) => session !== null);

    if (!searchTerm) return params.limit ? sessions.slice(0, params.limit) : sessions;

    const matched = sessions.filter((session) => matchesSearch(session, searchTerm));
    return params.limit ? matched.slice(0, params.limit) : matched;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail> {
    this.assertReady();

    const response = await this.appServer.request<ThreadReadResponse>("thread/read", {
      threadId: sessionId,
      includeTurns: true
    });

    const metadata = await this.readMetadata();
    const summary = this.toSummary(response.thread, metadata);
    if (!summary || (summary.id !== sessionId && summary.sessionId !== sessionId)) {
      throw new Error("Session not found");
    }

    const thread = response.thread && typeof response.thread === "object" ? (response.thread as Record<string, unknown>) : {};
    const modelState = await this.buildModelState(sessionId, readString(thread.modelProvider));


    return {
      ...summary,
      path: readString(thread.path),
      modelProvider: readString(thread.modelProvider),
      historyMode: readString(thread.historyMode),
      modelState,
      turns: readArray(thread.turns).map((turn, index) => toTurn(turn, index))
    };
  }

  async updateMetadata(sessionId: string, remarkTitle: string | null): Promise<SessionSummary> {
    if (!this.metadataStore) {
      throw new Error("Session metadata store is not configured");
    }

    await this.metadataStore.update(sessionId, { remarkTitle });
    const sessions = await this.listSessions({ limit: 200 });
    const session = sessions.find((item) => item.id === sessionId || item.sessionId === sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    return session;
  }

  private async buildModelState(sessionId: string, threadModelProvider: string | null): Promise<SessionModelState> {
    const [metadata, historical] = await Promise.all([
      this.metadataStore?.get?.(sessionId),
      this.jsonlParser?.readModelState(sessionId).catch(() => undefined)
    ]);
    const runtime = this.runtimeManager?.getRuntime(sessionId);
    const actualModel = runtime?.model ?? historical?.state.model ?? null;
    const actualModelProvider = runtime?.modelProvider ?? historical?.state.modelProvider ?? threadModelProvider;
    const actualReasoningEffort = runtime?.reasoningEffort ?? historical?.state.reasoningEffort ?? null;
    let actualModelSupported: boolean | null = null;

    if (actualModel && this.modelCatalog) {
      try {
        const catalog = await this.modelCatalog.list();
        actualModelSupported = catalog.models.some((model) => model.model === actualModel);
      } catch {
        actualModelSupported = null;
      }
    }

    const persisted = metadata?.modelSelection ?? {
      mode: "follow_session" as const,
      preferredModel: null,
      preferredReasoningEffort: null,
      updatedAt: null
    };

    if (runtime && runtime.status !== "history") {
      return {
        ...runtime.modelSelection,
        actualModel,
        actualModelProvider,
        actualReasoningEffort,
        actualModelSupported
      };
    }

    return {
      ...persisted,
      actualModel,
      actualModelProvider,
      actualReasoningEffort,
      actualModelSupported,
      applied: persisted.mode === "override" && persisted.preferredModel === actualModel,
      confirmationPending: false,
      lastError: null
    };
  }

  private assertReady(): void {
    const snapshot = this.appServer.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.initialized) {
      throw new Error("Codex app-server is not ready");
    }
  }

  private async readMetadata(): Promise<Record<string, { remarkTitle: string | null }>> {
    return this.metadataStore ? this.metadataStore.getAll() : {};
  }

  private toSummary(thread: unknown, metadata: Record<string, { remarkTitle: string | null }>): SessionSummary | null {
    if (!thread || typeof thread !== "object") return null;
    const source = thread as Record<string, unknown>;
    const id = readString(source.id) ?? readString(source.sessionId);
    if (!id) return null;

    const sessionId = readString(source.sessionId) ?? id;
    const preview = readString(source.preview);
    const name = readString(source.name);
    const cwd = readString(source.cwd);
    const createdAt = readUnixSeconds(source.createdAt);
    const updatedAt = readUnixSeconds(source.updatedAt);
    const defaultTitle = name ?? makeTitle(preview, id);
    const remarkTitle = metadata[id]?.remarkTitle ?? metadata[sessionId]?.remarkTitle ?? null;

    return {
      id,
      sessionId,
      title: remarkTitle ?? defaultTitle,
      defaultTitle,
      remarkTitle,
      summary: preview ?? "无摘要",
      workspace: cwd ?? "未知工作目录",
      createdAt,
      updatedAt,
      status: mapThreadStatus(source.status),
      cliVersion: readString(source.cliVersion),
      source: readSource(source.source)
    };
  }
}

function toTurn(value: unknown, index: number): SessionTurn {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: readString(source.id) ?? `turn-${index + 1}`,
    status: readString(source.status) ?? "unknown",
    error: readError(source.error),
    startedAt: readUnixSeconds(source.startedAt),
    completedAt: readNullableUnixSeconds(source.completedAt),
    durationMs: readNumber(source.durationMs),
    items: readArray(source.items).map((item, itemIndex) => toTurnItem(item, itemIndex))
  };
}

function toTurnItem(value: unknown, index: number): SessionTurnItem {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawType = readString(source.type);
  const id = readString(source.id) ?? `item-${index + 1}`;

  switch (rawType) {
    case "userMessage":
      return {
        id,
        type: "user_message",
        text: readTextContent(source.content)
      };
    case "agentMessage":
      return {
        id,
        type: "agent_message",
        text: readString(source.text) ?? "",
        phase: readString(source.phase)
      };
    case "fileChange":
      return {
        id,
        type: "file_change",
        status: readString(source.status),
        changes: readArray(source.changes).map(toFileChange)
      };
    case "contextCompaction":
      return { id, type: "context_compaction" };
    default:
      return { id, type: "unknown", rawType };
  }
}

function toFileChange(value: unknown): SessionFileChange {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const kind = source.kind && typeof source.kind === "object" ? readString((source.kind as Record<string, unknown>).type) : null;
  return {
    path: readString(source.path) ?? "未知文件",
    kind,
    diff: readString(source.diff)
  };
}

function readTextContent(value: unknown): string {
  return readArray(value)
    .map((item) => (item && typeof item === "object" ? readString((item as Record<string, unknown>).text) : null))
    .filter((text): text is string => text !== null)
    .join("\n\n");
}

function matchesSearch(session: SessionSummary, searchTerm: string): boolean {
  return [session.id, session.sessionId, session.title, session.defaultTitle, session.remarkTitle, session.summary, session.workspace]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLocaleLowerCase().includes(searchTerm));
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeModelError(value);
  if (typeof value === "object" && "message" in value) {
    const message = readString((value as { message?: unknown }).message);
    return message ? sanitizeModelError(message) : null;
  }
  return sanitizeModelError(String(value));
}

function readUnixSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return new Date(0).toISOString();
  return new Date(value * 1000).toISOString();
}

function readNullableUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function readSource(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "type" in value) {
    return readString((value as { type?: unknown }).type);
  }
  return null;
}

function makeTitle(preview: string | null, id: string): string {
  if (!preview) return id;
  const compact = preview.replace(/\s+/g, " ").trim();
  return compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
}

function mapThreadStatus(value: unknown): SessionStatus {
  const type = typeof value === "string" ? value : value && typeof value === "object" ? readString((value as { type?: unknown }).type) : null;

  switch (type) {
    case "running":
    case "inProgress":
    case "loaded":
      return "running";
    case "starting":
      return "starting";
    case "waiting_input":
    case "waitingInput":
      return "waiting_input";
    case "waiting_approval":
    case "waitingApproval":
      return "waiting_approval";
    case "failed":
    case "errored":
      return "failed";
    case "completed":
    case "exited":
      return "exited";
    case "notLoaded":
    case null:
    default:
      return "history";
  }
}
