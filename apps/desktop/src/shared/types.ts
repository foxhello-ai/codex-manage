export type ComponentState = "idle" | "starting" | "running" | "stopped" | "failed";

export type TunnelState = "idle" | "starting" | "online" | "reconnecting" | "stopped" | "failed";

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
  onStatus(listener: (status: DesktopStatus) => void): () => void;
};
