import type { CodexAppServerClient } from "./CodexAppServerClient";
import type { SessionMetadataStore } from "./SessionMetadataStore";

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

type ThreadListResponse = {
  data?: unknown[];
  nextCursor?: string | null;
};

type ListSessionsParams = {
  search?: string;
  limit?: number;
};

type MetadataStore = Pick<SessionMetadataStore, "getAll" | "update">;

export class SessionService {
  constructor(
    private readonly appServer: Pick<CodexAppServerClient, "request" | "getSnapshot">,
    private readonly metadataStore?: MetadataStore
  ) {}

  async listSessions(params: ListSessionsParams = {}): Promise<SessionSummary[]> {
    const snapshot = this.appServer.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.initialized) {
      throw new Error("Codex app-server is not ready");
    }

    const response = await this.appServer.request<ThreadListResponse>("thread/list", {
      limit: params.limit ?? 100,
      sortDirection: "desc",
      sortKey: "updated_at",
      archived: false,
      searchTerm: null
    });

    const metadata = await this.readMetadata();
    const searchTerm = params.search?.trim().toLocaleLowerCase() ?? "";
    const sessions = (response.data ?? [])
      .map((thread) => this.toSummary(thread, metadata))
      .filter((session) => session !== null);

    if (!searchTerm) return sessions;

    return sessions.filter((session) => matchesSearch(session, searchTerm));
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

  private async readMetadata(): Promise<Record<string, { remarkTitle: string | null }>> {
    return this.metadataStore ? this.metadataStore.getAll() : {};
  }

  private toSummary(thread: unknown, metadata: Record<string, { remarkTitle: string | null }>): SessionSummary | null {
    if (!thread || typeof thread !== "object") return null;
    const source = thread as Record<string, unknown>;
    const id = readString(source.id);
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

function matchesSearch(session: SessionSummary, searchTerm: string): boolean {
  return [session.id, session.sessionId, session.title, session.defaultTitle, session.remarkTitle, session.summary, session.workspace]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLocaleLowerCase().includes(searchTerm));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readUnixSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return new Date(0).toISOString();
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
