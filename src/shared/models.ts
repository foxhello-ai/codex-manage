export type UserSession = {
  authenticated: boolean;
  defaultPassword: boolean;
};

export type PublicConfig = {
  host: string;
  port: number;
  codexCliPath: string;
  sessionsDir: string;
  defaultPassword: boolean;
  codexCliVersion: string | null;
  codexVersionError: string | null;
  appServer: {
    status: "idle" | "starting" | "ready" | "failed" | "exited";
    pid: number | null;
    lastError: string | null;
    initialized: boolean;
  } | null;
};

export type SessionStatus = "history" | "starting" | "running" | "waiting_input" | "waiting_approval" | "exited" | "failed";

export type SessionSummary = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  cliVersion: string | null;
  source: string | null;
};

export type SessionsResponse = {
  sessions: SessionSummary[];
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
