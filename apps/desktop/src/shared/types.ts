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

export type PaymentChannel = "wechat" | "alipay";

export type BillingPlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_period: string;
  duration_days: number | null;
  purchase_enabled: boolean;
  features: Record<string, unknown>;
  status: string;
  sort_order: number;
};

export type BillingOrder = {
  id: string;
  order_no: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  amount_cents: number;
  currency: string;
  channel: PaymentChannel;
  status: string;
  expires_at: string;
  paid_at: string | null;
  closed_at: string | null;
  created_at: string;
};

export type BillingPayment = {
  id: string;
  provider: PaymentChannel;
  channel: string;
  status: string;
  qr_code_url: string | null;
  expires_at: string;
  paid_at: string | null;
  provider_transaction_id: string | null;
};

export type BillingOrderDetail = {
  order: BillingOrder;
  payment: BillingPayment | null;
  fulfillment: {
    fulfilled: true;
    business_object_type: string;
    business_object_id: string;
    starts_at: string;
    expires_at: string | null;
    summary: Record<string, unknown>;
  } | null;
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
    ready: boolean;
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
  listBillingPlans(): Promise<{ plans: BillingPlan[] }>;
  createBillingOrder(planId: string, channel: PaymentChannel): Promise<{ order: BillingOrder }>;
  payBillingOrder(orderId: string, channel: PaymentChannel): Promise<BillingOrderDetail>;
  getBillingOrder(orderId: string): Promise<BillingOrderDetail>;
  closeBillingOrder(orderId: string): Promise<{ closed: boolean }>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
};
