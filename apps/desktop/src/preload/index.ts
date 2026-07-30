import { contextBridge, ipcRenderer } from "electron";
import type { CodexDesktopApi, DesktopStatus } from "../shared/types";

const api: CodexDesktopApi = {
  getStatus: () => ipcRenderer.invoke("desktop:get-status"),
  setupPassword: (password) => ipcRenderer.invoke("desktop:setup-password", password),
  requestVerificationCode: (type, identifier) => ipcRenderer.invoke("desktop:request-verification-code", type, identifier),
  registerAccount: (type, identifier, code, password) => ipcRenderer.invoke("desktop:register-account", type, identifier, code, password),
  loginAccount: (identifier, password) => ipcRenderer.invoke("desktop:login-account", identifier, password),
  logoutAccount: () => ipcRenderer.invoke("desktop:logout-account"),
  unbindDevice: () => ipcRenderer.invoke("desktop:unbind-device"),
  provisionNamedTunnel: () => ipcRenderer.invoke("desktop:provision-named-tunnel"),
  startTunnel: () => ipcRenderer.invoke("desktop:start-tunnel"),
  stopTunnel: () => ipcRenderer.invoke("desktop:stop-tunnel"),
  createPairingUrl: () => ipcRenderer.invoke("desktop:create-pairing-url"),
  openLocalManage: () => ipcRenderer.invoke("desktop:open-local-manage"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("desktop:set-launch-at-login", enabled),
  exportDiagnosticLogs: () => ipcRenderer.invoke("desktop:export-diagnostic-logs"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  submitIssueReport: (input) => ipcRenderer.invoke("desktop:submit-issue-report", input),
  setIssueAutoReportEnabled: (enabled) => ipcRenderer.invoke("desktop:set-issue-auto-report-enabled", enabled),
  listBillingPlans: () => ipcRenderer.invoke("desktop:list-billing-plans"),
  createBillingOrder: (planId, channel) => ipcRenderer.invoke("desktop:create-billing-order", planId, channel),
  payBillingOrder: (orderId, channel) => ipcRenderer.invoke("desktop:pay-billing-order", orderId, channel),
  getBillingOrder: (orderId) => ipcRenderer.invoke("desktop:get-billing-order", orderId),
  closeBillingOrder: (orderId) => ipcRenderer.invoke("desktop:close-billing-order", orderId),
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => listener(status);
    ipcRenderer.on("desktop:status", handler);
    return () => ipcRenderer.removeListener("desktop:status", handler);
  }
};

contextBridge.exposeInMainWorld("codexDesktop", api);
