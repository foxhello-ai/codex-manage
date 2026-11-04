export type UserRole = "owner" | "child";

export type UserIdentity = {
  id: string;
  role: UserRole;
  displayName: string;
  localEmail: string | null;
  active: boolean;
  ownerUserId: string | null;
};

export type UserSession = {
  authenticated: boolean;
  defaultPassword: boolean;
  user?: UserIdentity;
};

export type LoginAccount = Pick<UserIdentity, "id" | "role" | "displayName" | "localEmail">;

export type LoginAccountsResponse = {
  accounts: LoginAccount[];
};

export type Collaborator = UserIdentity & {
  grants: string[];
  createdAt: string;
};

export type CollaboratorsResponse = {
  collaborators: Collaborator[];
};

export type CreateCollaboratorResponse = {
  collaborator: Collaborator;
  initialPassword: string;
};

export type AppServerSnapshot = {
  status: "idle" | "starting" | "ready" | "failed" | "exited";
  pid: number | null;
  lastError: string | null;
  initialized: boolean;
};

export type RuntimeReloadSnapshot = {
  generation: number;
  reloadedAt: string | null;
  trigger: "manual" | "config_watcher" | null;
  reason: string | null;
  lastError: string | null;
};

export type PublicConfig = {
  host: string;
  port: number;
  codexCliPath: string;
  sessionsDir: string;
  defaultPassword: boolean;
  codexCliVersion: string | null;
  codexVersionError: string | null;
  appServer: AppServerSnapshot | null;
  runtimeReload: RuntimeReloadSnapshot | null;
};

export type HealthStatus = {
  ok: boolean;
  checkedAt: string;
  codexCli: {
    available: boolean;
    version: string | null;
    error: string | null;
  };
  appServer: AppServerSnapshot | null;
};

export type RuntimeReloadResponse = {
  runtime: {
    generation: number;
    reloadedAt: string;
    trigger: "manual" | "config_watcher";
    reason: string | null;
    codexCliVersion: string | null;
    appServer: AppServerSnapshot;
  };
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

export type SessionBranchMode = "compact_new_topic" | "full_fork";

export type SessionBranchResponse = {
  session: SessionSummary;
  runtime: RuntimeSnapshot;
  mode: SessionBranchMode;
};

export type SessionHistoryContinuationResponse = {
  session: SessionSummary;
  runtime: RuntimeSnapshot;
  sourceSessionId: string;
  inputError: string | null;
  metadataError: string | null;
};

export type CreateSessionResponse = {
  threadId: string;
  runtime: RuntimeSnapshot;
  session: SessionSummary;
};

export type SessionsResponse = {
  nextCursor?: string | null;
  sessions: SessionSummary[];
};

export type TaskSummary = {
  id: string;
  name: string;
  pinned: boolean;
  sessionIds: string[];
  sessionCount: number;
  recentSessionId: string | null;
  recentSessionTitle: string | null;
  updatedAt: string;
};

export type TaskDetail = TaskSummary & {
  sessions: SessionSummary[];
};

export type TasksResponse = {
  tasks: TaskSummary[];
};

export type TaskDetailResponse = {
  task: TaskDetail;
};

export type CreateTaskResponse = {
  task: TaskSummary;
};

export type CreateTaskSessionResponse = CreateSessionResponse & {
  task: TaskSummary;
  contextPrompt: string;
};

export type SessionMetadataResponse = {
  session: SessionSummary;
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string | null;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  upgradeModel: string | null;
  upgradeCopy: string | null;
};

export type ModelCatalogResponse = {
  models: ModelOption[];
  loadedAt: string;
  stale: boolean;
  lastError: string | null;
};

export type ModelSelectionMode = "follow_session" | "override";

export type PersistedModelSelection = {
  mode: ModelSelectionMode;
  preferredModel: string | null;
  preferredReasoningEffort: string | null;
  updatedAt: string | null;
};

export type SessionModelState = PersistedModelSelection & {
  actualModel: string | null;
  actualModelProvider: string | null;
  actualReasoningEffort: string | null;
  actualModelSupported: boolean | null;
  applied: boolean;
  confirmationPending: boolean;
  lastError: string | null;
};

export type ModelChangeStatus = "idle" | "pending" | "confirming" | "applied" | "failed";

export type UpdateModelSelectionInput =
  | {
      mode: "follow_session";
      model?: null;
      reasoningEffort?: null;
    }
  | {
      mode: "override";
      model: string;
      reasoningEffort?: string | null;
    };

export type ModelOverrideInput = {
  model: string;
  reasoningEffort?: string | null;
};

export type ValidatedModelSelection = {
  model: string;
  reasoningEffort: string | null;
  option: ModelOption;
};

export type ResolvedModelOverride = {
  mode: ModelSelectionMode;
  model: string | null;
  reasoningEffort: string | null;
};

export type ModelErrorCode =
  | "MODEL_LIST_UNAVAILABLE"
  | "MODEL_NOT_SUPPORTED"
  | "MODEL_EFFORT_NOT_SUPPORTED"
  | "MODEL_SWITCH_NOT_ALLOWED"
  | "MODEL_SWITCH_FAILED"
  | "MODEL_SWITCH_MISMATCH"
  | "MODEL_PREFERENCE_PERSIST_FAILED"
  | "MODEL_PROVIDER_UNAVAILABLE"
  | "MODEL_REQUEST_TIMEOUT"
  | "RUNTIME_RELOAD_BLOCKED"
  | "SESSION_ACTIVE_WRITER";


export type SessionDetailResponse = {
  session: SessionDetail;
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
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  modelSelection: SessionModelState;
  modelChangeStatus: ModelChangeStatus;
  modelChangeError: string | null;
};

export type RuntimeResponse = {
  runtime: RuntimeSnapshot;
};

export type InputResponse = {
  runtime: RuntimeSnapshot;
};

export type ModelSelectionResponse = {
  selection: SessionModelState;
  runtime: RuntimeSnapshot;
  applied: boolean;
  confirmationPending: boolean;
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
    | "model_change_started"
    | "model_change_completed"
    | "model_change_failed"
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
