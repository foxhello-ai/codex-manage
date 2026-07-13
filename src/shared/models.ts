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

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
