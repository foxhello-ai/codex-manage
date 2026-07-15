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

export type SessionsResponse = {
  sessions: SessionSummary[];
};

export type SessionMetadataResponse = {
  session: SessionSummary;
};


export type SessionDetailResponse = {
  session: SessionDetail;
};

export type SessionDetail = SessionSummary & {
  path: string | null;
  modelProvider: string | null;
  historyMode: string | null;
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


export type SessionCommandsResponse = {
  commands: SessionCommand[];
  diagnostics: SessionCommandDiagnostics;
};

export type SessionCommandDiagnostics = {
  scannedFiles: number;
  parsedLines: number;
  parseErrors: number;
  matchedSessionFile: boolean;
};

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

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type RuntimeStatus = SessionStatus;

export type SessionPermissionMode = "default" | "full_access";

export type RuntimeSnapshot = {
  threadId: string;
  status: RuntimeStatus;
  permissionMode: SessionPermissionMode;
  activeTurnId: string | null;
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
  pendingApprovalCount: number;
  eventSeq: number;
};

export type RuntimeResponse = {
  runtime: RuntimeSnapshot;
};

export type InputResponse = {
  runtime: RuntimeSnapshot;
};

export type WebSessionEvent = {
  seq: number;
  threadId: string;
  type:
    | "snapshot"
    | "session_status"
    | "turn_started"
    | "turn_completed"
    | "agent_message_delta"
    | "command_started"
    | "command_output_delta"
    | "command_completed"
    | "approval_requested"
    | "approval_resolved"
    | "error"
    | "warning"
    | "raw";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ApprovalKind =
  | "command_execution"
  | "file_change"
  | "permissions"
  | "tool_user_input"
  | "legacy_exec"
  | "legacy_apply_patch";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "approved_for_session"
  | "declined"
  | "cancelled"
  | "resolved"
  | "failed";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type ApprovalSummary = {
  id: string;
  requestId: number;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  questions: ApprovalQuestion[];
  raw: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
};

export type ApprovalQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ApprovalQuestionOption[] | null;
};

export type ApprovalQuestionOption = {
  label: string;
  description: string;
};

export type ApprovalResponse = {
  approval: ApprovalSummary;
  runtime: RuntimeSnapshot | null;
};
