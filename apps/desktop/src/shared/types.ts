export type ComponentState = "idle" | "starting" | "running" | "stopped" | "failed";

export type TunnelState = "idle" | "starting" | "online" | "reconnecting" | "stopped" | "failed";
export type UpdateState = "idle" | "checking" | "not_available" | "available" | "downloading" | "downloaded" | "installing" | "error";

export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  targetVersion: string | null;
  lastCheckedAt: string | null;
  progressPercent: number | null;
  error: string | null;
  manual: boolean;
};

export type IssueReportCategory = "crash" | "unavailable" | "defect" | "optimization" | "requirement";

export type IssueReportSubmission = {
  category: IssueReportCategory;
  title: string;
  description: string;
};

export type IssueReportSubmissionResult = {
  queued: boolean;
  reportId: string | null;
  duplicateCount: number | null;
};

export type IssueReportingStatus = {
  autoEnabled: boolean;
  queuedCount: number;
  lastSubmittedAt: string | null;
  lastError: string | null;
};

export type RuntimeReloadStatus = {
  state: "idle" | "pending" | "reloading" | "blocked" | "failed" | "succeeded";
  trigger: "desktop_auto" | null;
  reason: string | null;
  lastDetectedAt: string | null;
  lastAttemptAt: string | null;
  lastReloadedAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
};

export type DesktopStatus = {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  localService: {
    state: ComponentState;
    url: string | null;
    port: number | null;
    error: string | null;
  };
  codex: {
    available: boolean;
    path: string | null;
    version: string | null;
    error: string | null;
  };
  auth: {
    setupRequired: boolean;
    activeSessionCount: number;
  };
  settings: {
    launchAtLogin: boolean;
  };
  issueReporting: IssueReportingStatus;
  runtimeReload: RuntimeReloadStatus;
  account: {
    authenticated: boolean;
    identifier: string | null;
    deviceId: string | null;
    entitlements: Record<string, string | number | boolean>;
    subscription: {
      planCode: string;
      planName: string;
      expiresAt: string | null;
    } | null;
    namedTunnelStatus: string | null;
    error: string | null;
  };
  tunnel: {
    state: TunnelState;
    mode: "quick" | "named";
    publicUrl: string | null;
    error: string | null;
  };
  update: UpdateStatus;
};

export type CodexDesktopApi = {
  getStatus(): Promise<DesktopStatus>;
  setupPassword(password: string): Promise<DesktopStatus>;
  requestVerificationCode(type: "email" | "phone", identifier: string): Promise<{ sent: boolean; expiresAt: string; debugCode?: string }>;
  registerAccount(type: "email" | "phone", identifier: string, code: string, password: string): Promise<DesktopStatus>;
  loginAccount(identifier: string, password: string): Promise<DesktopStatus>;
  logoutAccount(): Promise<DesktopStatus>;
  unbindDevice(): Promise<DesktopStatus>;
  provisionNamedTunnel(): Promise<DesktopStatus>;
  startTunnel(): Promise<DesktopStatus>;
  stopTunnel(): Promise<DesktopStatus>;
  createPairingUrl(): Promise<{ url: string; expiresAt: string }>;
  openLocalManage(): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<DesktopStatus>;
  exportDiagnosticLogs(): Promise<string | null>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  submitIssueReport(input: IssueReportSubmission): Promise<IssueReportSubmissionResult>;
  setIssueAutoReportEnabled(enabled: boolean): Promise<DesktopStatus>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
};
