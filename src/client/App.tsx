import { FormEvent, KeyboardEvent, PointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getHealthStatus, getMe, getModels, getPublicConfig, getSessionCommands, getSessionDetail, getSessionRuntime, getSessionWebSocketUrl, getSessions, login, logout, resumeSession, sendSessionInput, submitApproval, updateSessionMetadata, updateSessionModel } from "../shared/api";
import type { ApprovalDecision, ApprovalSummary, HealthStatus, ModelCatalogResponse, PublicConfig, RuntimeSnapshot, SessionCommand, SessionCommandDiagnostics, SessionDetail, SessionModelState, SessionPermissionMode, SessionSummary, SessionStatus, SessionTurnItem, UpdateModelSelectionInput, UserSession, WebSessionEvent } from "../shared/models";
import { ModelSelector } from "./ModelSelector";
import { modelSwitchDisabledReason } from "./modelSelection";
import { isTaskSendShortcut, shouldAutoFollowLiveOutput } from "./sessionInteractions";
import { buildSessionDetailPath, parseSessionRoute, type SessionRoute } from "./sessionRoute";

type LoadState = "loading" | "ready" | "error";
type WebSocketStatus = "idle" | "connecting" | "connected" | "disconnected";
type DashboardView = "list" | "settings" | "detail" | "invalid";

type LiveCommand = {
  id: string;
  turnId: string | null;
  itemId: string | null;
  command: string;
  cwd: string;
  status: string | null;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
};

type LiveMessage = {
  id: string;
  role: "user" | "agent";
  turnId: string | null;
  itemId: string | null;
  text: string;
  deliveryStatus: "sending" | "sent" | "failed" | null;
};

type LiveErrorNotice = {
  id: string;
  message: string;
  code: string | null;
  willRetry: boolean;
  createdAt: string;
};


export function App() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [session, setSession] = useState<UserSession | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const me = await getMe();
        if (cancelled) return;
        setSession(me);

        if (me.authenticated) {
          const publicConfig = await getPublicConfig();
          if (cancelled) return;
          setConfig(publicConfig);
        }

        setLoadState("ready");
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "初始化失败");
        setLoadState("error");
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLoggedIn(nextSession: UserSession) {
    setSession(nextSession);
    setConfig(await getPublicConfig());
  }

  async function handleLogout() {
    const nextSession = await logout();
    setSession(nextSession);
    setConfig(null);
  }

  if (loadState === "loading") {
    return <Shell title="Codex Manage">正在载入...</Shell>;
  }

  if (loadState === "error") {
    return <Shell title="Codex Manage">{error}</Shell>;
  }

  if (!session?.authenticated) {
    return <LoginView defaultPassword={session?.defaultPassword ?? true} onLoggedIn={handleLoggedIn} />;
  }

  return <Dashboard config={config} defaultPassword={session.defaultPassword} onLogout={handleLogout} />;
}

function LoginView({
  defaultPassword,
  onLoggedIn
}: {
  defaultPassword: boolean;
  onLoggedIn: (session: UserSession) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const session = await login(password);
      await onLoggedIn(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="loginPage">
      <section className="loginPanel" aria-labelledby="login-title">
        <div>
          <p className="eyebrow">Codex Manage</p>
          <h1 id="login-title">登录管理台</h1>
          <p className="muted">管理本机 Codex 会话、恢复任务和处理审批。</p>
        </div>

        {defaultPassword ? (
          <div className="warning" role="status">
            当前密码可通过 CODEX_WEB_PASSWORD 覆盖。
          </div>
        ) : null}

        <form className="loginForm" onSubmit={handleSubmit}>
          <label htmlFor="password">密码</label>
          <input
            id="password"
            autoComplete="current-password"
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入管理密码"
          />
          {error ? <div className="errorText">{error}</div> : null}
          <button type="submit" disabled={submitting || password.length === 0}>
            {submitting ? "登录中" : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({
  config,
  defaultPassword,
  onLogout
}: {
  config: PublicConfig | null;
  defaultPassword: boolean;
  onLogout: () => Promise<void>;
}) {
  const [initialRoute] = useState(() => parseSessionRoute(window.location.pathname));
  const [currentConfig, setCurrentConfig] = useState(config);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(initialRoute.kind === "settings");
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [runtimeReloadNotice, setRuntimeReloadNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialRoute.kind === "detail" ? initialRoute.sessionId : null
  );
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(initialRoute.kind === "detail");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [commandDiagnostics, setCommandDiagnostics] = useState<SessionCommandDiagnostics | null>(null);
  const [loadingCommands, setLoadingCommands] = useState(initialRoute.kind === "detail");
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DashboardView>(initialRoute.kind === "list" ? "list" : initialRoute.kind);
  const [routeError, setRouteError] = useState<string | null>(initialRoute.kind === "invalid" ? initialRoute.message : null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [permissionMode, setPermissionMode] = useState<SessionPermissionMode>("default");
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalSummary[]>([]);
  const [liveCommands, setLiveCommands] = useState<LiveCommand[]>([]);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);
  const [liveErrors, setLiveErrors] = useState<LiveErrorNotice[]>([]);
  const [wsStatus, setWsStatus] = useState<WebSocketStatus>("idle");
  const [wsReconnectKey, setWsReconnectKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [modelActionError, setModelActionError] = useState<string | null>(null);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [retryDialogOpen, setRetryDialogOpen] = useState(false);
  const lastEventSeqRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(initialRoute.kind === "detail" ? initialRoute.sessionId : null);
  const liveMessagesRef = useRef<LiveMessage[]>([]);
  const retryMessageRef = useRef<string | null>(null);
  const runtimeReloadGenerationRef = useRef<number | null>(null);

  const listenAddress = useMemo(() => {
    if (!currentConfig) return "读取中";
    return `${currentConfig.host}:${currentConfig.port}`;
  }, [currentConfig]);
  const appServerStatus = currentConfig?.appServer
    ? `${currentConfig.appServer.status}${currentConfig.appServer.initialized ? " / initialized" : ""}`
    : "未连接";
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
    ?? (sessionDetail?.id === selectedSessionId ? sessionDetail : null);
  const currentModelState = runtime && runtime.status !== "history"
    ? runtime.modelSelection
    : sessionDetail?.modelState ?? runtime?.modelSelection ?? emptyModelState();

  async function loadSessions(nextSearch = search) {
    setLoadingSessions(true);
    setSessionError(null);

    try {
      const response = await getSessions(nextSearch);
      setSessions(response.sessions);
    } catch (caught) {
      setSessionError(caught instanceof Error ? caught.message : "会话列表加载失败");
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadDiagnostics() {
    setLoadingDiagnostics(true);
    setDiagnosticsError(null);

    try {
      const [nextConfig, nextHealth] = await Promise.all([getPublicConfig(), getHealthStatus()]);
      setCurrentConfig(nextConfig);
      setHealth(nextHealth);
    } catch (caught) {
      setDiagnosticsError(caught instanceof Error ? caught.message : "诊断信息加载失败");
    } finally {
      setLoadingDiagnostics(false);
    }
  }

  useEffect(() => {
    if (config) setCurrentConfig(config);
  }, [config]);

  useEffect(() => {
    const generation = currentConfig?.runtimeReload?.generation ?? 0;
    if (runtimeReloadGenerationRef.current === null) {
      runtimeReloadGenerationRef.current = generation;
      return;
    }
    if (generation <= runtimeReloadGenerationRef.current) return;
    runtimeReloadGenerationRef.current = generation;
    setModelCatalog(null);
    setModelCatalogError(null);
    setRuntime((current) => current ? { ...current, status: "history", activeTurnId: null, lastError: null } : current);
    const reloadedAt = currentConfig?.runtimeReload?.reloadedAt;
    const trigger = currentConfig?.runtimeReload?.trigger;
    setRuntimeReloadNotice(
      `Codex 运行时已${trigger === "config_watcher" ? "自动" : ""}刷新${reloadedAt ? `：${formatDateTime(reloadedAt)}` : ""}`
    );
    void loadModelCatalog(true);
    if (selectedSessionIdRef.current) {
      void loadRuntime(selectedSessionIdRef.current, { silent: true });
    }
  }, [currentConfig?.runtimeReload?.generation]);

  useEffect(() => {
    let active = true;
    async function pollRuntimeConfig() {
      try {
        const nextConfig = await getPublicConfig();
        if (active) setCurrentConfig(nextConfig);
      } catch {
        // 自动刷新检测是后台能力，诊断页保留显式错误展示。
      }
    }
    const timer = setInterval(() => void pollRuntimeConfig(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void loadSessions("");
    if (initialRoute.kind === "detail") {
      void refreshCurrentSession(initialRoute.sessionId);
    }
    if (initialRoute.kind === "settings") {
      void loadDiagnostics();
    }
  }, []);

  useEffect(() => {
    function handlePopState() {
      applySessionRoute(parseSessionRoute(window.location.pathname));
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    liveMessagesRef.current = liveMessages;
  }, [liveMessages]);

  useEffect(() => {
    retryMessageRef.current = retryMessage;
  }, [retryMessage]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawerOpen]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loadSessions(search);
  }

  async function loadSessionDetail(sessionId: string, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoadingDetail(true);
    setDetailError(null);

    try {
      const response = await getSessionDetail(sessionId);
      if (selectedSessionIdRef.current !== sessionId) return;
      setSessionDetail(response.session);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return;
      if (!options.silent) setSessionDetail(null);
      setDetailError(caught instanceof Error ? caught.message : "会话详情加载失败");
    } finally {
      if (!options.silent && selectedSessionIdRef.current === sessionId) setLoadingDetail(false);
    }
  }

  async function loadSessionCommands(sessionId: string, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoadingCommands(true);
    setCommandsError(null);
    if (!options.silent) setCommandDiagnostics(null);

    try {
      const response = await getSessionCommands(sessionId);
      if (selectedSessionIdRef.current !== sessionId) return;
      setCommands(response.commands);
      setCommandDiagnostics(response.diagnostics);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return;
      if (!options.silent) setCommands([]);
      setCommandsError(caught instanceof Error ? caught.message : "历史命令加载失败");
    } finally {
      if (!options.silent && selectedSessionIdRef.current === sessionId) setLoadingCommands(false);
    }
  }

  function syncRuntimeSnapshot(nextRuntime: RuntimeSnapshot) {
    setRuntime(nextRuntime);
    setSessionDetail((current) => current && current.id === nextRuntime.threadId
      ? { ...current, status: nextRuntime.status, modelState: nextRuntime.modelSelection }
      : current);
    if (nextRuntime.status !== "history") {
      setPermissionMode(nextRuntime.permissionMode);
    }
  }

  async function loadRuntime(sessionId: string, options: { silent?: boolean } = {}) {
    if (!options.silent) setRuntimeError(null);
    try {
      const response = await getSessionRuntime(sessionId);
      if (selectedSessionIdRef.current !== sessionId) return;
      syncRuntimeSnapshot(response.runtime);
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, response.runtime.eventSeq);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return;
      if (!options.silent) setRuntimeError(caught instanceof Error ? caught.message : "运行状态加载失败");
    }
  }

  async function refreshCurrentSession(sessionId: string, options: { silent?: boolean } = {}) {
    await Promise.all([
      loadSessionDetail(sessionId, options),
      loadSessionCommands(sessionId, options),
      loadRuntime(sessionId, options)
    ]);
  }

  async function pollCurrentSessionAfterInput(sessionId: string) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await delay(attempt === 0 ? 800 : 2000);
      if (selectedSessionIdRef.current !== sessionId) return;
      await refreshCurrentSession(sessionId, { silent: true });
    }
  }

  async function loadModelCatalog(forceRefresh = false) {
    if (!forceRefresh && modelCatalog) return;
    setLoadingModels(true);
    setModelCatalogError(null);
    try {
      const response = await getModels(forceRefresh);
      setModelCatalog(response);
      if (response.stale && response.lastError) setModelCatalogError(response.lastError);
    } catch (caught) {
      setModelCatalogError(caught instanceof Error ? caught.message : "支持模型列表加载失败");
    } finally {
      setLoadingModels(false);
    }
  }

  function handleOpenModelPicker() {
    const disabledReason = modelSwitchDisabledReason(runtime?.status ?? selectedSession?.status ?? "history");
    if (disabledReason) {
      setModelActionError(disabledReason);
      return;
    }
    setModelActionError(null);
    setModelPickerOpen(true);
    void loadModelCatalog();
  }

  async function handleApplyModel(input: UpdateModelSelectionInput) {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    setUpdatingModel(true);
    setModelActionError(null);
    try {
      const response = await updateSessionModel(sessionId, input);
      if (selectedSessionIdRef.current !== sessionId) return;
      syncRuntimeSnapshot(response.runtime);
      setSessionDetail((current) => current && current.id === sessionId
        ? { ...current, modelState: response.selection }
        : current);
      setModelPickerOpen(false);
      if (retryMessageRef.current) setRetryDialogOpen(true);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return;
      const message = caught instanceof Error ? caught.message : "模型切换失败";
      setModelActionError(message);
      setLiveErrors((current) => upsertById(current, {
        id: `model-action-${sessionId}`,
        message,
        code: "MODEL_SWITCH_FAILED",
        willRetry: false,
        createdAt: new Date().toISOString()
      }));
      await loadRuntime(sessionId, { silent: true });
    } finally {
      setUpdatingModel(false);
    }
  }

  async function handleRetryLastMessage() {
    if (!retryMessage) return;
    await handleSendInput(retryMessage, { isRetry: true });
    setRetryDialogOpen(false);
    setRetryMessage(null);
    retryMessageRef.current = null;
  }

  function applyRealtimeEvent(event: WebSessionEvent) {
    if (selectedSessionIdRef.current !== event.threadId) return;
    lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
    const payload = event.payload as Record<string, unknown>;

    if (event.type === "session_status" && isRuntimeSnapshot(payload.runtime)) {
      syncRuntimeSnapshot(payload.runtime);
      return;
    }

    if (event.type === "turn_completed") {
      void refreshCurrentSession(event.threadId, { silent: true });
      return;
    }

    if (event.type === "model_change_started") {
      const requestedModel = readPayloadString(payload.requestedModel);
      const reasoningEffort = readPayloadString(payload.reasoningEffort);
      setModelActionError(null);
      setRuntime((current) => current ? {
        ...current,
        modelChangeStatus: "pending",
        modelChangeError: null,
        modelSelection: {
          ...current.modelSelection,
          mode: requestedModel ? "override" : current.modelSelection.mode,
          preferredModel: requestedModel ?? current.modelSelection.preferredModel,
          preferredReasoningEffort: reasoningEffort,
          applied: false,
          confirmationPending: false,
          lastError: null
        }
      } : current);
      return;
    }

    if (event.type === "model_change_completed") {
      const actualModel = readPayloadString(payload.actualModel);
      const modelProvider = readPayloadString(payload.modelProvider);
      const reasoningEffort = readPayloadString(payload.reasoningEffort);
      setModelActionError(null);
      setRuntime((current) => current ? {
        ...current,
        model: actualModel ?? current.model,
        modelProvider: modelProvider ?? current.modelProvider,
        reasoningEffort,
        modelChangeStatus: "applied",
        modelChangeError: null,
        modelSelection: {
          ...current.modelSelection,
          actualModel: actualModel ?? current.modelSelection.actualModel,
          actualModelProvider: modelProvider ?? current.modelSelection.actualModelProvider,
          actualReasoningEffort: reasoningEffort,
          actualModelSupported: true,
          applied: true,
          confirmationPending: false,
          lastError: null
        }
      } : current);
      void refreshCurrentSession(event.threadId, { silent: true });
      if (retryMessageRef.current) setRetryDialogOpen(true);
      return;
    }

    if (event.type === "model_change_failed") {
      const message = readPayloadString(payload.message) ?? "模型切换失败";
      const code = readPayloadString(payload.errorCode);
      setModelActionError(message);
      setRuntime((current) => current ? {
        ...current,
        modelChangeStatus: "failed",
        modelChangeError: message,
        modelSelection: { ...current.modelSelection, applied: false, confirmationPending: false, lastError: message }
      } : current);
      setLiveErrors((current) => upsertById(current, {
        id: `model-change-${event.threadId}`,
        message,
        code,
        willRetry: false,
        createdAt: event.createdAt
      }));
      return;
    }

    if (event.type === "error") {
      const message = readRealtimeErrorMessage(payload) ?? "Codex 执行失败";
      const willRetry = payload.willRetry === true;
      const turnId = readPayloadString(payload.turnId) ?? "current";
      const retryingId = `retrying-${event.threadId}-${turnId}`;
      setLiveErrors((current) => willRetry
        ? upsertById(current, { id: retryingId, message, code: readPayloadString(payload.errorCode), willRetry, createdAt: event.createdAt })
        : [
            ...current.filter((item) => item.id !== retryingId),
            {
              id: `terminal-${event.seq}`,
              message,
              code: readPayloadString(payload.errorCode),
              willRetry: false,
              createdAt: event.createdAt
            }
          ]);
      if (!willRetry) {
        const failedMessage = [...liveMessagesRef.current].reverse().find((messageItem) => messageItem.role === "user")?.text ?? null;
        retryMessageRef.current = failedMessage;
        setRetryMessage(failedMessage);
      }
      return;
    }

    if (event.type === "approval_requested" && isApprovalSummary(payload.approval)) {
      const approval = payload.approval;
      setPendingApprovals((current) => upsertById(current, approval));
      return;
    }

    if (event.type === "approval_resolved" && isApprovalSummary(payload.approval)) {
      const approval = payload.approval;
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      return;
    }

    if (event.type === "agent_message_delta") {
      const itemId = readPayloadString(payload.itemId) ?? `${event.seq}`;
      const turnId = readPayloadString(payload.turnId);
      const delta = readPayloadString(payload.delta) ?? "";
      setLiveMessages((current) => appendLiveMessage(current, {
        id: itemId,
        role: "agent",
        itemId,
        turnId,
        text: delta,
        deliveryStatus: null
      }));
      return;
    }

    if (event.type === "command_started") {
      const itemId = readPayloadString(payload.itemId) ?? `${event.seq}`;
      const command: LiveCommand = {
        id: itemId,
        itemId,
        turnId: readPayloadString(payload.turnId),
        command: readPayloadString(payload.command) ?? "",
        cwd: readPayloadString(payload.cwd) ?? "",
        status: readPayloadString(payload.status) ?? "running",
        output: readPayloadString(payload.output) ?? "",
        exitCode: null,
        durationMs: null
      };
      setLiveCommands((current) => upsertById(current, command));
      return;
    }

    if (event.type === "command_output_delta") {
      const itemId = readPayloadString(payload.itemId);
      const delta = readPayloadString(payload.delta) ?? "";
      if (!itemId) return;
      setLiveCommands((current) => appendCommandOutput(current, itemId, delta));
      return;
    }

    if (event.type === "command_completed") {
      const itemId = readPayloadString(payload.itemId) ?? `${event.seq}`;
      setLiveCommands((current) =>
        upsertById(current, {
          id: itemId,
          itemId,
          turnId: readPayloadString(payload.turnId),
          command: readPayloadString(payload.command) ?? "",
          cwd: readPayloadString(payload.cwd) ?? "",
          status: readPayloadString(payload.status) ?? "completed",
          output: readPayloadString(payload.output) ?? current.find((command) => command.id === itemId)?.output ?? "",
          exitCode: readPayloadNumber(payload.exitCode),
          durationMs: readPayloadNumber(payload.durationMs)
        })
      );
    }
  }

  function resetSessionDetailState(sessionId: string | null) {
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setSessionDetail(null);
    setCommands([]);
    setCommandDiagnostics(null);
    setRuntime(null);
    setPermissionMode("default");
    setPendingApprovals([]);
    setLiveCommands([]);
    setLiveMessages([]);
    liveMessagesRef.current = [];
    setLiveErrors([]);
    setRuntimeError(null);
    setModelActionError(null);
    setModelPickerOpen(false);
    setRetryMessage(null);
    retryMessageRef.current = null;
    setRetryDialogOpen(false);
    lastEventSeqRef.current = 0;
  }

  function applySessionRoute(route: SessionRoute) {
    if (route.kind === "list") {
      setRouteError(null);
      setViewMode("list");
      return;
    }

    if (route.kind === "settings") {
      setDrawerOpen(false);
      setRouteError(null);
      setViewMode("settings");
      void loadDiagnostics();
      return;
    }

    if (route.kind === "invalid") {
      setDrawerOpen(false);
      resetSessionDetailState(null);
      setRouteError(route.message);
      setViewMode("invalid");
      return;
    }

    resetSessionDetailState(route.sessionId);
    setDrawerOpen(false);
    setRouteError(null);
    setViewMode("detail");
    void refreshCurrentSession(route.sessionId);
  }

  function handleSelectSession(session: SessionSummary) {
    const path = buildSessionDetailPath(session.id);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    applySessionRoute({ kind: "detail", sessionId: session.id });
  }

  function handleMetadataSaved(updated: SessionSummary) {
    setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
    setSessionDetail((current) => (current && current.id === updated.id ? { ...current, ...updated } : current));
  }

  useEffect(() => {
    if (!selectedSessionId) {
      setWsStatus("idle");
      return;
    }

    let closed = false;
    let reconnectTimer: number | undefined;
    const socket = new WebSocket(getSessionWebSocketUrl(selectedSessionId, lastEventSeqRef.current));
    setWsStatus("connecting");

    socket.addEventListener("open", () => setWsStatus("connected"));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as WebSessionEvent;
      if (event.type === "snapshot") {
        const payload = event.payload as Record<string, unknown>;
        if (isRuntimeSnapshot(payload.runtime)) syncRuntimeSnapshot(payload.runtime);
        if (Array.isArray(payload.approvals)) setPendingApprovals(payload.approvals.filter(isApprovalSummary));
        if (Array.isArray(payload.events)) payload.events.forEach((item) => applyRealtimeEvent(item as WebSessionEvent));
        lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
        return;
      }
      applyRealtimeEvent(event);
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      setWsStatus("disconnected");
      reconnectTimer = window.setTimeout(() => setWsReconnectKey((key) => key + 1), 1500);
    });
    socket.addEventListener("error", () => setWsStatus("disconnected"));

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket.close();
    };
  }, [selectedSessionId, wsReconnectKey]);

  async function handleResume() {
    if (!selectedSessionId) return;
    setRuntimeError(null);
    try {
      const response = await resumeSession(selectedSessionId, permissionMode);
      syncRuntimeSnapshot(response.runtime);
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "恢复会话失败");
    }
  }

  async function handleSendInput(text: string, options: { isRetry?: boolean } = {}) {
    if (!selectedSessionId) return;
    if (!options.isRetry) {
      setRetryDialogOpen(false);
      setRetryMessage(null);
      retryMessageRef.current = null;
    }
    const sessionId = selectedSessionId;
    const messageId = createLocalMessageId();
    const localMessage: LiveMessage = {
      id: messageId,
      role: "user",
      turnId: null,
      itemId: null,
      text,
      deliveryStatus: "sending"
    };
    setRuntimeError(null);
    liveMessagesRef.current = [...liveMessagesRef.current, localMessage];
    setLiveMessages((current) => [...current, localMessage]);
    try {
      const response = await sendSessionInput(sessionId, text, permissionMode);
      if (selectedSessionIdRef.current !== sessionId) return;
      setLiveMessages((current) => updateLiveMessageDeliveryStatus(current, messageId, "sent"));
      syncRuntimeSnapshot(response.runtime);
      void pollCurrentSessionAfterInput(sessionId);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) throw caught;
      setLiveMessages((current) => updateLiveMessageDeliveryStatus(current, messageId, "failed"));
      const message = caught instanceof Error ? caught.message : "任务发送失败";
      setRuntimeError(message);
      setLiveErrors((current) => upsertById(current, {
        id: `input-${messageId}`,
        message,
        code: null,
        willRetry: false,
        createdAt: new Date().toISOString()
      }));
      retryMessageRef.current = text;
      setRetryMessage(text);
      throw caught;
    }
  }

  async function handlePermissionModeChange(nextMode: SessionPermissionMode) {
    if (!selectedSessionId) return;
    const status = runtime?.status ?? "history";
    setRuntimeError(null);

    if (status !== "waiting_input") {
      setPermissionMode(nextMode);
      return;
    }

    try {
      const response = await resumeSession(selectedSessionId, nextMode);
      syncRuntimeSnapshot(response.runtime);
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "权限模式切换失败");
      throw caught;
    }
  }


  async function handleSubmitApproval(approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) {
    setRuntimeError(null);
    try {
      const response = await submitApproval(approval.threadId, approval.id, decision, answers);
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      if (response.runtime) syncRuntimeSnapshot(response.runtime);
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "审批处理失败");
    }
  }

  async function handleRefresh() {
    await loadSessions(search);
    if (selectedSessionIdRef.current) {
      await refreshCurrentSession(selectedSessionIdRef.current);
    }
  }

  function handleBackToList() {
    if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
    setRouteError(null);
    setDrawerOpen(false);
    setViewMode("list");
  }

  function handleOpenSettings() {
    if (window.location.pathname !== "/settings") window.history.pushState(null, "", "/settings");
    applySessionRoute({ kind: "settings" });
  }

  function renderSessionBrowser(showHeading = true) {
    return (
      <SessionBrowser
        sessions={sessions}
        search={search}
        loadingSessions={loadingSessions}
        sessionError={sessionError}
        selectedSessionId={selectedSessionId}
        showHeading={showHeading}
        onSearchChange={setSearch}
        onSearchSubmit={handleSearchSubmit}
        onRefresh={() => loadSessions(search)}
        onSelect={handleSelectSession}
        onMetadataSaved={handleMetadataSaved}
      />
    );
  }

  return (
    <Shell
      title="Codex Manage"
      reserveFloatingStatus={viewMode === "detail" && Boolean(selectedSession)}
      action={(
        <div className="topbarActions">
          <button
            className="iconButton"
            type="button"
            aria-label="打开设置和诊断"
            title="设置和诊断"
            onClick={handleOpenSettings}
            disabled={viewMode === "settings"}
          >
            <span aria-hidden="true">⚙</span>
          </button>
          <button className="ghostButton" onClick={onLogout}>登出</button>
        </div>
      )}
    >
      {defaultPassword ? (
        <div className="warning" role="status">
          当前密码可通过 CODEX_WEB_PASSWORD 覆盖。
        </div>
      ) : null}

      {viewMode === "list" ? (
        <>
          <section className="toolbar">
            <div>
              <h2>会话管理</h2>
              <p className="muted">查看 ~/.codex/sessions 中的历史会话，恢复会话并继续任务。</p>
            </div>
            <div className="toolbarActions">
              <button
                className="iconButton mobileOnly"
                type="button"
                aria-label="打开会话列表"
                title="会话列表"
                onClick={() => setDrawerOpen(true)}
              >
                <span aria-hidden="true">☰</span>
              </button>
              <button className="ghostButton" onClick={() => loadSessions(search)} disabled={loadingSessions}>
                {loadingSessions ? "刷新中" : "刷新"}
              </button>
            </div>
          </section>

          <section className="infoGrid compact" aria-label="当前配置">
            <InfoItem label="监听地址" value={listenAddress} />
            <InfoItem label="Codex 版本" value={currentConfig?.codexCliVersion ?? currentConfig?.codexVersionError ?? "读取中"} />
            <InfoItem label="App Server" value={appServerStatus} />
          </section>

          <section className="sessionSection desktopSessionPanel" aria-label="会话列表">
            {renderSessionBrowser()}
          </section>
        </>
      ) : viewMode === "detail" ? (
        <>
          <section className="toolbar detailToolbar">
            <div className="detailTitleBar">
              <button className="iconButton" aria-label="返回会话列表" title="返回会话列表" onClick={handleBackToList}>
                <span aria-hidden="true">←</span>
              </button>
              <div>
                <p className="detailEyebrow">当前会话</p>
                <h2 title={selectedSession?.title ?? selectedSessionId ?? "会话加载失败"}>
                  {selectedSession?.title ?? (loadingDetail ? "正在加载会话..." : "会话加载失败")}
                </h2>
              </div>
            </div>
            <div className="toolbarActions">
              <button className="ghostButton" onClick={handleRefresh} disabled={loadingSessions || loadingDetail || loadingCommands}>
                {loadingSessions || loadingDetail || loadingCommands ? "刷新中" : "刷新"}
              </button>
            </div>
          </section>

          {selectedSession ? (
            <MobileRuntimeStatus
              sessionTitle={selectedSession.title}
              runtime={runtime}
              wsStatus={wsStatus}
              pendingApprovalCount={pendingApprovals.length}
            />
          ) : null}

          <section className="sessionDetail" aria-labelledby="session-detail-title">
            <h2 id="session-detail-title" className="srOnly">当前会话详情</h2>
            {selectedSession ? (
              <SessionDetailPanel
                fallbackSession={selectedSession}
                detail={sessionDetail}
                loading={loadingDetail}
                error={detailError}
                commands={commands}
                commandDiagnostics={commandDiagnostics}
                loadingCommands={loadingCommands}
                commandsError={commandsError}
                runtime={runtime}
                permissionMode={permissionMode}
                runtimeError={runtimeError}
                pendingApprovals={pendingApprovals}
                liveCommands={liveCommands}
                liveMessages={liveMessages}
                liveErrors={liveErrors}
                wsStatus={wsStatus}
                modelState={currentModelState}
                updatingModel={updatingModel}
                onResume={handleResume}
                onPermissionModeChange={handlePermissionModeChange}
                onOpenModelPicker={handleOpenModelPicker}
                onSendInput={handleSendInput}
                onOpenRetry={() => setRetryDialogOpen(true)}
                onSubmitApproval={handleSubmitApproval}
              />
            ) : loadingDetail ? (
              <div className="emptyState">正在加载会话详情...</div>
            ) : (
              <div className="routeErrorState">
                <div className="errorBanner">{detailError ?? "会话不存在或无法读取"}</div>
                <button className="ghostButton" type="button" onClick={handleBackToList}>返回会话列表</button>
              </div>
            )}
          </section>
        </>
      ) : viewMode === "settings" ? (
        <SettingsPage
          config={currentConfig}
          health={health}
          loading={loadingDiagnostics}
          error={diagnosticsError}
          reloadNotice={runtimeReloadNotice}
          onBack={handleBackToList}
          onRefresh={loadDiagnostics}
        />
      ) : (
        <>
          <section className="toolbar detailToolbar">
            <div className="detailTitleBar">
              <button className="iconButton" aria-label="返回会话列表" title="返回会话列表" onClick={handleBackToList}>
                <span aria-hidden="true">←</span>
              </button>
              <div>
                <p className="detailEyebrow">会话链接</p>
                <h2>无法打开会话</h2>
              </div>
            </div>
          </section>
          <section className="sessionDetail" aria-label="会话链接错误">
            <div className="routeErrorState">
              <div className="errorBanner">{routeError ?? "会话链接格式不正确"}</div>
              <button className="ghostButton" type="button" onClick={handleBackToList}>返回会话列表</button>
            </div>
          </section>
        </>
      )}

      {viewMode === "list" && drawerOpen ? (
        <div className="drawerBackdrop" role="presentation" onClick={() => setDrawerOpen(false)}>
          <aside
            className="sessionDrawer"
            role="dialog"
            aria-modal="true"
            aria-label="会话列表"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="drawerHeader">
              <div>
                <h2>会话列表</h2>
                <p className="muted">共 {sessions.length} 个会话</p>
              </div>
              <button className="iconButton" type="button" aria-label="关闭会话列表" title="关闭" onClick={() => setDrawerOpen(false)}>
                <span aria-hidden="true">×</span>
              </button>
            </div>
            {renderSessionBrowser(false)}
          </aside>
        </div>
      ) : null}

      {viewMode === "detail" && selectedSession ? (
        <FloatingRuntimeStatus
          sessionTitle={selectedSession.title}
          runtime={runtime}
          wsStatus={wsStatus}
          pendingApprovalCount={pendingApprovals.length}
        />
      ) : null}

      {viewMode === "detail" && selectedSession ? (
        <ModelSelector
          open={modelPickerOpen}
          catalog={modelCatalog}
          current={currentModelState}
          loading={loadingModels}
          submitting={updatingModel}
          error={modelActionError ?? modelCatalogError}
          onClose={() => setModelPickerOpen(false)}
          onRefresh={() => loadModelCatalog(true)}
          onApply={handleApplyModel}
        />
      ) : null}

      {viewMode === "detail" && retryDialogOpen && retryMessage ? (
        <RetryLastMessageDialog
          message={retryMessage}
          model={currentModelState.mode === "override" ? currentModelState.preferredModel : currentModelState.actualModel}
          onCancel={() => setRetryDialogOpen(false)}
          onConfirm={handleRetryLastMessage}
        />
      ) : null}
    </Shell>
  );
}


const DEFAULT_VISIBLE_TURNS = 5;
const DEFAULT_VISIBLE_GROUP_SESSIONS = 5;
const MAX_VISIBLE_LIVE_MESSAGES = 20;
const MAX_VISIBLE_LIVE_COMMANDS = 20;
const MAX_LIVE_COMMAND_OUTPUT_CHARS = 12000;
const FLOATING_RUNTIME_POSITION_KEY = "codex-manage-floating-runtime-position";

function SettingsPage({
  config,
  health,
  loading,
  error,
  reloadNotice,
  onBack,
  onRefresh
}: {
  config: PublicConfig | null;
  health: HealthStatus | null;
  loading: boolean;
  error: string | null;
  reloadNotice: string | null;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const appServer = health?.appServer ?? config?.appServer ?? null;
  const cliAvailable = health?.codexCli.available ?? Boolean(config?.codexCliVersion);
  const statusClass = health?.ok ? "healthy" : health ? "unhealthy" : "unknown";
  const statusText = loading && !health ? "检查中" : health?.ok ? "运行正常" : health ? "需要检查" : "状态未知";

  return (
    <>
      <section className="toolbar detailToolbar">
        <div className="detailTitleBar">
          <button className="iconButton" aria-label="返回会话列表" title="返回会话列表" onClick={onBack}>
            <span aria-hidden="true">←</span>
          </button>
          <div>
            <p className="detailEyebrow">系统</p>
            <h2>设置和诊断</h2>
          </div>
        </div>
        <div className="toolbarActions">
          <button className="ghostButton" type="button" onClick={() => void onRefresh()} disabled={loading}>
            {loading ? "检查中" : "重新检查"}
          </button>
        </div>
      </section>

      <section className={`healthOverview ${statusClass}`} aria-label="系统健康状态">
        <div>
          <p>系统健康</p>
          <strong>{statusText}</strong>
        </div>
        <span>{health?.checkedAt ? formatDateTime(health.checkedAt) : "尚未检查"}</span>
      </section>

      {error ? <div className="errorBanner">{error}</div> : null}
      {reloadNotice ? <div className="successBanner">{reloadNotice}</div> : null}
      {config?.codexVersionError ? <div className="errorBanner">Codex CLI：{config.codexVersionError}</div> : null}
      {appServer?.lastError ? <div className="errorBanner">App Server：{appServer.lastError}</div> : null}

      <section className="settingsSection" aria-labelledby="web-settings-title">
        <div className="settingsSectionHeader">
          <h3 id="web-settings-title">Web 服务</h3>
          <span>只读</span>
        </div>
        <div className="settingsRows">
          <SettingsRow label="监听地址" value={config?.host ?? "读取中"} />
          <SettingsRow label="监听端口" value={config ? String(config.port) : "读取中"} />
          <SettingsRow label="登录密码" value={config ? (config.defaultPassword ? "使用默认密码" : "环境变量已覆盖") : "读取中"} />
          <SettingsRow label="Sessions 目录" value={config?.sessionsDir ?? "读取中"} monospace />
        </div>
      </section>

      <section className="settingsSection" aria-labelledby="codex-settings-title">
        <div className="settingsSectionHeader">
          <h3 id="codex-settings-title">Codex 运行环境</h3>
          <span className={`diagnosticBadge ${cliAvailable ? "ready" : "failed"}`}>
            {cliAvailable ? "CLI 可用" : "CLI 不可用"}
          </span>
        </div>
        <div className="settingsRows">
          <SettingsRow label="Codex CLI 路径" value={config?.codexCliPath ?? "读取中"} monospace />
          <SettingsRow label="Codex CLI 版本" value={health?.codexCli.version ?? config?.codexCliVersion ?? "未读取"} />
          <SettingsRow label="App Server 状态" value={appServer ? appServerStatusLabel(appServer.status) : "未连接"} />
          <SettingsRow label="初始化" value={appServer?.initialized ? "已完成" : "未完成"} />
          <SettingsRow label="进程 ID" value={appServer?.pid ? String(appServer.pid) : "无"} monospace />
        </div>
      </section>
    </>
  );
}

function SettingsRow({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="settingsRow">
      <span>{label}</span>
      <strong className={monospace ? "monospaceValue" : undefined}>{value}</strong>
    </div>
  );
}

type FloatingPosition = {
  x: number;
  y: number;
};

function MobileRuntimeStatus({
  sessionTitle,
  runtime,
  wsStatus,
  pendingApprovalCount
}: {
  sessionTitle: string;
  runtime: RuntimeSnapshot | null;
  wsStatus: WebSocketStatus;
  pendingApprovalCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = runtime?.status ?? "history";

  return (
    <section className={`mobileRuntimeStatus ${status}${expanded ? " expanded" : ""}`} aria-label="移动运行状态">
      <button
        className="mobileRuntimeSummary"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "收起运行状态" : "展开运行状态"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="mobileRuntimePrimary">
          <strong>{statusLabel(status)}</strong>
          <small>{wsStatusLabel(wsStatus)}</small>
        </span>
        <span className="mobileRuntimeIndicators">
          {runtime?.permissionMode === "full_access" ? <small className="fullAccessBadge">完全权限</small> : null}
          {pendingApprovalCount > 0 ? <small className="approvalCount">待审批 {pendingApprovalCount}</small> : null}
          <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
        </span>
      </button>
      {expanded ? (
        <div className="mobileRuntimeDetails">
          <strong title={sessionTitle}>{sessionTitle}</strong>
          <div>
            <span>权限：{runtime?.permissionMode === "full_access" ? "完全权限" : "需审批"}</span>
            <span>事件：{runtime?.eventSeq ?? 0}</span>
          </div>
          {runtime?.lastError ? <p className="errorText">{runtime.lastError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function FloatingRuntimeStatus({
  sessionTitle,
  runtime,
  wsStatus,
  pendingApprovalCount
}: {
  sessionTitle: string;
  runtime: RuntimeSnapshot | null;
  wsStatus: WebSocketStatus;
  pendingApprovalCount: number;
}) {
  const status = runtime?.status ?? "history";
  const [position, setPosition] = useState<FloatingPosition>(() => readFloatingRuntimePosition());
  const positionRef = useRef(position);
  const dragOffsetRef = useRef<FloatingPosition | null>(null);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    function handleResize() {
      setPosition((current) => clampFloatingRuntimePosition(current));
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function beginDrag(event: PointerEvent<HTMLElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y
    };
  }

  function drag(event: PointerEvent<HTMLElement>) {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    const nextPosition = clampFloatingRuntimePosition({
      x: event.clientX - offset.x,
      y: event.clientY - offset.y
    });
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }

  function endDrag() {
    dragOffsetRef.current = null;
    saveFloatingRuntimePosition(positionRef.current);
  }

  return (
    <aside
      className={`floatingRuntimeStatus ${status}`}
      aria-label="浮动运行状态"
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="floatingRuntimeDragHandle"
        title="拖拽调整位置"
        onPointerDown={beginDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span>运行状态</span>
        <strong>{statusLabel(status)}</strong>
      </div>
      <div className="floatingRuntimeBody">
        <span title={sessionTitle}>{sessionTitle}</span>
        <div className="floatingRuntimeBadges">
          <span>{wsStatusLabel(wsStatus)}</span>
          {runtime?.permissionMode === "full_access" ? <span className="fullAccessBadge">完全权限</span> : null}
          {pendingApprovalCount > 0 ? <span className="approvalCount">待审批 {pendingApprovalCount}</span> : null}
        </div>
      </div>
    </aside>
  );
}

function readFloatingRuntimePosition(): FloatingPosition {
  try {
    const raw = window.localStorage.getItem(FLOATING_RUNTIME_POSITION_KEY);
    if (!raw) return defaultFloatingRuntimePosition();
    const parsed = JSON.parse(raw) as Partial<FloatingPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return defaultFloatingRuntimePosition();
    return clampFloatingRuntimePosition({ x: parsed.x, y: parsed.y });
  } catch {
    return defaultFloatingRuntimePosition();
  }
}

function saveFloatingRuntimePosition(position: FloatingPosition) {
  window.localStorage.setItem(FLOATING_RUNTIME_POSITION_KEY, JSON.stringify(position));
}

function defaultFloatingRuntimePosition(): FloatingPosition {
  return clampFloatingRuntimePosition({
    x: window.innerWidth - 304,
    y: 88
  });
}

function clampFloatingRuntimePosition(position: FloatingPosition): FloatingPosition {
  const compact = window.innerWidth <= 767;
  const width = compact ? 210 : 280;
  const height = compact ? 82 : 126;
  const margin = 12;
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, window.innerHeight - height - margin))
  };
}

function SessionDetailPanel({
  fallbackSession,
  detail,
  loading,
  error,
  commands,
  commandDiagnostics,
  loadingCommands,
  commandsError,
  runtime,
  permissionMode,
  runtimeError,
  pendingApprovals,
  liveCommands,
  liveMessages,
  liveErrors,
  wsStatus,
  modelState,
  updatingModel,
  onResume,
  onPermissionModeChange,
  onOpenModelPicker,
  onSendInput,
  onOpenRetry,
  onSubmitApproval
}: {
  fallbackSession: SessionSummary;
  detail: SessionDetail | null;
  loading: boolean;
  error: string | null;
  commands: SessionCommand[];
  commandDiagnostics: SessionCommandDiagnostics | null;
  loadingCommands: boolean;
  commandsError: string | null;
  runtime: RuntimeSnapshot | null;
  permissionMode: SessionPermissionMode;
  runtimeError: string | null;
  pendingApprovals: ApprovalSummary[];
  liveCommands: LiveCommand[];
  liveMessages: LiveMessage[];
  liveErrors: LiveErrorNotice[];
  wsStatus: WebSocketStatus;
  modelState: SessionModelState;
  updatingModel: boolean;
  onResume: () => Promise<void>;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
  onOpenModelPicker: () => void;
  onSendInput: (text: string) => Promise<void>;
  onOpenRetry: () => void;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  const session = detail ?? fallbackSession;
  const [expandedMessage, setExpandedMessage] = useState<{ title: string; text: string; meta?: string } | null>(null);
  const [visibleTurnCount, setVisibleTurnCount] = useState(DEFAULT_VISIBLE_TURNS);
  const [showHistoryDuringLive, setShowHistoryDuringLive] = useState(false);
  const hasLiveOutput = liveMessages.length > 0 || liveErrors.length > 0 || liveCommands.some((command) => !isLiveCommandCompleted(command));
  const showHistory = !hasLiveOutput || showHistoryDuringLive;

  useEffect(() => {
    setVisibleTurnCount(DEFAULT_VISIBLE_TURNS);
    setShowHistoryDuringLive(false);
  }, [session.id]);

  async function handleSendInput(text: string) {
    setShowHistoryDuringLive(false);
    await onSendInput(text);
  }

  return (
    <div className="detailStack">
      <div className="detailScrollContent">
        {runtime?.permissionMode === "full_access" ? (
          pendingApprovals.length > 0 ? <div className="errorBanner">完全权限模式收到未预期的审批请求，系统未自动处理。</div> : null
        ) : (
          <ApprovalPanel approvals={pendingApprovals} onSubmitApproval={onSubmitApproval} />
        )}
        {!showHistoryDuringLive ? (
          <LiveOutputPanel
            liveMessages={liveMessages}
            liveCommands={liveCommands}
            liveErrors={liveErrors}
            runtimeStatus={runtime?.status ?? "history"}
            canRetry={Boolean(liveErrors.some((notice) => !notice.willRetry) && liveMessages.some((message) => message.role === "user"))}
            onChooseModel={onOpenModelPicker}
            onRetry={onOpenRetry}
            onShowHistory={() => setShowHistoryDuringLive(true)}
          />
        ) : null}

        <div className="sessionHero">
          <div>
            <p className="eyebrow">{session.remarkTitle ? "会话备注" : "会话名称"}</p>
            <h3>{session.title}</h3>
            {session.remarkTitle ? <p className="muted">默认标题：{session.defaultTitle}</p> : null}
          </div>
          <div className="sessionHeroMeta">
            <span>{formatDateTime(session.updatedAt)}</span>
            <span title={session.id}>{shortId(session.id)}</span>
          </div>
        </div>

        <RuntimePanel
          runtime={runtime}
          permissionMode={permissionMode}
          wsStatus={wsStatus}
          error={runtimeError}
          modelState={modelState}
          updatingModel={updatingModel}
          onResume={onResume}
          onPermissionModeChange={onPermissionModeChange}
          onOpenModelPicker={onOpenModelPicker}
        />

        {hasLiveOutput && !showHistory ? <div className="historyHiddenNotice">实时输出进行中，历史会话内容已隐藏。</div> : null}
        {showHistory ? (
          <div className="historyContent">
            {hasLiveOutput ? (
              <div className="historyHeader">
                <div>
                  <h3>历史会话内容</h3>
                  <p className="muted">实时输出已隐藏。</p>
                </div>
                <button className="ghostButton" type="button" onClick={() => setShowHistoryDuringLive(false)}>
                  返回实时输出
                </button>
              </div>
            ) : null}
            {loading ? <div className="emptyState">正在加载详情...</div> : null}
            {error ? <div className="errorBanner">{error}</div> : null}
            {detail && detail.turns.length === 0 ? <div className="emptyState">暂无历史消息</div> : null}
            {detail && detail.turns.length > 0 ? (
              <SessionTimeline
                detail={detail}
                visibleTurnCount={visibleTurnCount}
                onLoadMore={() => setVisibleTurnCount((count) => count + DEFAULT_VISIBLE_TURNS)}
                onOpenMessage={setExpandedMessage}
              />
            ) : null}
            <SessionCommandsPanel
              commands={commands}
              diagnostics={commandDiagnostics}
              loading={loadingCommands}
              error={commandsError}
            />
          </div>
        ) : null}
      </div>
      <TaskInput runtime={runtime} onSend={handleSendInput} />
      {expandedMessage ? <MessageDetailDialog message={expandedMessage} onClose={() => setExpandedMessage(null)} /> : null}
    </div>
  );
}


function RuntimePanel({
  runtime,
  permissionMode,
  wsStatus,
  error,
  modelState,
  updatingModel,
  onResume,
  onPermissionModeChange,
  onOpenModelPicker
}: {
  runtime: RuntimeSnapshot | null;
  permissionMode: SessionPermissionMode;
  wsStatus: WebSocketStatus;
  error: string | null;
  modelState: SessionModelState;
  updatingModel: boolean;
  onResume: () => Promise<void>;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
  onOpenModelPicker: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [updatingPermission, setUpdatingPermission] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const status = runtime?.status ?? "history";
  const canChangePermission = status === "history" || status === "waiting_input" || status === "exited" || status === "failed";
  const modelDisabledReason = modelSwitchDisabledReason(status);
  const actualModel = runtime?.model ?? modelState.actualModel;
  const actualProvider = runtime?.modelProvider ?? modelState.actualModelProvider;
  const actualEffort = runtime?.reasoningEffort ?? modelState.actualReasoningEffort;

  async function handleResume() {
    setSubmitting(true);
    try {
      await onResume();
    } finally {
      setSubmitting(false);
    }
  }

  async function applyPermissionMode(nextMode: SessionPermissionMode) {
    setUpdatingPermission(true);
    try {
      await onPermissionModeChange(nextMode);
    } finally {
      setUpdatingPermission(false);
    }
  }

  function handlePermissionToggle() {
    if (!canChangePermission || updatingPermission) return;
    if (permissionMode === "default") {
      setConfirmFullAccess(true);
      return;
    }
    void applyPermissionMode("default").catch(() => undefined);
  }

  async function confirmPermissionMode() {
    setConfirmFullAccess(false);
    try {
      await applyPermissionMode("full_access");
    } catch {
      return;
    }
  }


  return (
    <section className="runtimePanel" aria-label="运行状态">
      <div>
        <h3>运行状态</h3>
        <div className="runtimeBadges">
          <StatusBadge status={status} />
          <span>{wsStatusLabel(wsStatus)}</span>
          <span className={permissionMode === "full_access" ? "permissionBadge fullAccess" : "permissionBadge"}>{permissionMode === "full_access" ? "完全权限" : "需审批"}</span>
          {runtime?.pendingApprovalCount ? <span>待审批 {runtime.pendingApprovalCount}</span> : null}
        </div>
        <div className="permissionControl">
          <span className="permissionControlLabel">权限模式</span>
          <label className={`permissionToggle ${permissionMode === "full_access" ? "enabled" : ""}`}>
            <input type="checkbox" checked={permissionMode === "full_access"} disabled={!canChangePermission || updatingPermission} onChange={handlePermissionToggle} aria-label="完全权限" />
            <span className="permissionToggleTrack" aria-hidden="true">
              <span className="permissionToggleThumb" />
            </span>
            <strong>{updatingPermission ? "切换中" : permissionMode === "full_access" ? "已开启" : "需审批"}</strong>
          </label>
        </div>
        {!canChangePermission ? <p className="permissionUnavailable">当前状态不可切换权限模式</p> : null}
        <div className="modelControl">
          <div className="modelStateGrid">
            <span>当前模型</span>
            <strong title={actualModel ?? "未识别"}>{actualModel ?? "未识别"}</strong>
            {modelState.actualModelSupported === false ? <small className="unsupportedModelBadge">当前会话模型，不在可选列表</small> : null}
            <span>提供方 / 推理强度</span>
            <strong>{[actualProvider, actualEffort].filter(Boolean).join(" · ") || "未识别"}</strong>
            <span>Web 偏好</span>
            <strong title={modelState.preferredModel ?? undefined}>
              {modelState.mode === "override"
                ? [modelState.preferredModel, modelState.preferredReasoningEffort].filter(Boolean).join(" · ")
                : "跟随会话"}
            </strong>
          </div>
          <div className="modelControlActions">
            <button className="ghostButton" type="button" onClick={onOpenModelPicker} disabled={Boolean(modelDisabledReason) || updatingModel}>
              {updatingModel ? "切换中" : modelState.actualModelSupported === false ? "切换到支持模型" : "切换模型"}
            </button>
            {modelDisabledReason ? <p>{modelDisabledReason}</p> : null}
            {!modelDisabledReason && modelState.mode === "override" && !modelState.applied ? <p>已保存，将在恢复会话时应用。</p> : null}
            {modelState.confirmationPending || runtime?.modelChangeStatus === "confirming" ? <p>app-server 已接受，正在等待实际模型确认。</p> : null}
            {runtime?.modelChangeStatus && runtime.modelChangeStatus !== "idle" ? <p>切换状态：{modelChangeStatusLabel(runtime.modelChangeStatus)}</p> : null}
          </div>
        </div>
        {runtime?.modelChangeError || modelState.lastError ? <p className="errorText">{runtime?.modelChangeError ?? modelState.lastError}</p> : null}
        {runtime?.lastError ? <p className="errorText">{runtime.lastError}</p> : null}
        {error ? <p className="errorText">{error}</p> : null}
      </div>
      <button className="ghostButton" type="button" onClick={handleResume} disabled={submitting || status === "starting" || status === "running" || status === "waiting_input" || status === "waiting_approval"}>
        {submitting ? "恢复中" : status === "history" || status === "failed" || status === "exited" ? "恢复会话" : "已恢复"}
      </button>
      {confirmFullAccess ? (
        <FullAccessConfirmDialog
          submitting={updatingPermission}
          onCancel={() => setConfirmFullAccess(false)}
          onConfirm={confirmPermissionMode}
        />
      ) : null}
    </section>
  );
}

function FullAccessConfirmDialog({
  submitting,
  onCancel,
  onConfirm
}: {
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="modalBackdrop" role="presentation" onClick={submitting ? undefined : onCancel}>
      <section className="messageDialog fullAccessDialog" role="dialog" aria-modal="true" aria-labelledby="full-access-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialogHeader">
          <div>
            <h2 id="full-access-title">启用完全权限</h2>
            <p className="muted">当前会话</p>
          </div>
        </div>
        <div className="dialogBody fullAccessDialogBody">
          <div className="fullAccessWarning" role="alert">
            <strong>该会话将跳过审批。</strong>
            <p>Codex 将以 Web 服务账号获得完整文件系统和网络访问权限。</p>
          </div>
          <div className="dialogActions">
            <button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button>
            <button className="dangerButton" type="button" onClick={() => void onConfirm()} disabled={submitting}>{submitting ? "启用中" : "确认启用"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function RetryLastMessageDialog({
  message,
  model,
  onCancel,
  onConfirm
}: {
  message: string;
  model: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmRetry() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重试发送失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modalBackdrop" role="presentation" onClick={submitting ? undefined : onCancel}>
      <section className="messageDialog retryMessageDialog" role="dialog" aria-modal="true" aria-labelledby="retry-message-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialogHeader">
          <div>
            <h2 id="retry-message-title">确认重试上一条消息</h2>
            <p className="muted">将创建新的 turn，原失败记录会保留。</p>
          </div>
        </div>
        <div className="dialogBody retryMessageBody">
          <div className="retryModelSummary">
            <span>本次使用模型</span>
            <strong title={model ?? "跟随会话"}>{model ?? "跟随会话"}</strong>
          </div>
          <div className="retryMessagePreview">
            <span>原消息内容</span>
            <div><MarkdownContent text={message} /></div>
          </div>
          {error ? <div className="errorBanner">{error}</div> : null}
          <div className="dialogActions">
            <button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button>
            <button type="button" onClick={() => void confirmRetry()} disabled={submitting}>{submitting ? "重试中" : "使用当前模型重试"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}


function ApprovalPanel({
  approvals,
  onSubmitApproval
}: {
  approvals: ApprovalSummary[];
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  if (approvals.length === 0) return null;

  return (
    <section className="approvalPanel" aria-label="审批请求">
      <div className="panelHeaderCompact">
        <h3>待审批</h3>
        <span>{approvals.length}</span>
      </div>
      <div className="approvalList">
        {approvals.map((approval) => (
          <ApprovalCard approval={approval} key={approval.id} onSubmitApproval={onSubmitApproval} />
        ))}
      </div>
    </section>
  );
}

function ApprovalCard({
  approval,
  onSubmitApproval
}: {
  approval: ApprovalSummary;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  async function submit(decision: ApprovalDecision) {
    setSubmitting(decision);
    try {
      const answerPayload = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value.trim() ? [value.trim()] : []]));
      await onSubmitApproval(approval, decision, answerPayload);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <article className="approvalCard">
      <div className="approvalHeader">
        <div>
          <strong>{approval.title}</strong>
          {approval.reason ? <p className="muted">{approval.reason}</p> : null}
        </div>
        <span>{approval.kind}</span>
      </div>
      {approval.command ? <pre className="commandText">{approval.command}</pre> : null}
      {approval.cwd ? <p className="muted">{approval.cwd}</p> : null}
      {approval.questions.length > 0 ? (
        <div className="approvalQuestions">
          {approval.questions.map((question) => (
            <label key={question.id}>
              <span>{question.header}: {question.question}</span>
              {question.options && question.options.length > 0 ? (
                <select value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>
                  <option value="">请选择</option>
                  {question.options.map((option) => (
                    <option key={option.label} value={option.label}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={question.isSecret ? "password" : "text"}
                  value={answers[question.id] ?? ""}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      ) : null}
      <div className="approvalActions">
        <div className="approvalAllowActions">
          <button className="approvalAcceptButton" type="button" onClick={() => submit("accept")} disabled={submitting !== null} aria-busy={submitting === "accept"}>
            {submitting === "accept" ? "正在允许" : "允许一次"}
          </button>
          <button className="approvalSessionButton" type="button" onClick={() => submit("acceptForSession")} disabled={submitting !== null} aria-busy={submitting === "acceptForSession"}>
            {submitting === "acceptForSession" ? "正在设置" : "本会话允许"}
          </button>
        </div>
        <div className="approvalDismissActions">
          <button className="approvalDeclineButton" type="button" onClick={() => submit("decline")} disabled={submitting !== null} aria-busy={submitting === "decline"}>
            {submitting === "decline" ? "正在拒绝" : "拒绝"}
          </button>
          <button className="ghostButton" type="button" onClick={() => submit("cancel")} disabled={submitting !== null} aria-busy={submitting === "cancel"}>
            {submitting === "cancel" ? "正在取消" : "取消"}
          </button>
        </div>
      </div>
    </article>
  );
}

function LiveOutputPanel({
  liveMessages,
  liveCommands,
  liveErrors,
  runtimeStatus,
  canRetry,
  onChooseModel,
  onRetry,
  onShowHistory
}: {
  liveMessages: LiveMessage[];
  liveCommands: LiveCommand[];
  liveErrors: LiveErrorNotice[];
  runtimeStatus: SessionStatus;
  canRetry: boolean;
  onChooseModel: () => void;
  onRetry: () => void;
  onShowHistory: () => void;
}) {
  const outputBodyRef = useRef<HTMLDivElement | null>(null);
  const runningCommands = useMemo(() => liveCommands.filter((command) => !isLiveCommandCompleted(command)), [liveCommands]);
  const visibleMessages = useMemo(() => liveMessages.slice(-MAX_VISIBLE_LIVE_MESSAGES), [liveMessages]);
  const visibleCommands = useMemo(() => runningCommands.slice(-MAX_VISIBLE_LIVE_COMMANDS), [runningCommands]);
  const hiddenCount = liveMessages.length + runningCommands.length - visibleMessages.length - visibleCommands.length;
  const visibleCount = liveMessages.length + runningCommands.length + liveErrors.length;

  useEffect(() => {
    if (!shouldAutoFollowLiveOutput(runtimeStatus)) return;
    const outputBody = outputBodyRef.current;
    if (!outputBody) return;
    outputBody.scrollTop = outputBody.scrollHeight;
  }, [runtimeStatus, visibleMessages, visibleCommands, liveErrors]);

  if (visibleCount === 0) return null;

  return (
    <section className="livePanel" aria-label="实时输出">
      <div className="panelHeaderCompact">
        <h3>实时输出</h3>
        <div className="panelHeaderActions">
          <button className="ghostButton" type="button" onClick={onShowHistory}>
            查看历史会话内容
          </button>
          <span>{visibleCount}</span>
        </div>
      </div>
      <div className="liveOutputBody" ref={outputBodyRef}>
        {hiddenCount > 0 ? <div className="liveHiddenNotice">已隐藏较早的 {hiddenCount} 条实时输出</div> : null}
        {liveErrors.map((notice) => (
          <LiveErrorCard
            notice={notice}
            canRetry={canRetry && !notice.willRetry}
            onChooseModel={onChooseModel}
            onRetry={onRetry}
            key={notice.id}
          />
        ))}
        {visibleMessages.map((message) => (
          <article className={`messageItem ${message.role} liveMessage${message.deliveryStatus ? ` ${message.deliveryStatus}` : ""}`} key={message.id}>
            <div className="messageHeader">
              <strong>{message.role === "user" ? "用户" : "Codex"}</strong>
              <span className={message.deliveryStatus ? `deliveryStatus ${message.deliveryStatus}` : undefined}>
                {message.deliveryStatus ? deliveryStatusLabel(message.deliveryStatus) : "实时"}
              </span>
            </div>
            <div className="messageBody"><MarkdownContent text={message.text || "..."} /></div>
          </article>
        ))}
        {visibleCommands.map((command) => (
          <LiveCommandCard command={command} key={command.id} />
        ))}
      </div>
    </section>
  );
}

function LiveErrorCard({
  notice,
  canRetry,
  onChooseModel,
  onRetry
}: {
  notice: LiveErrorNotice;
  canRetry: boolean;
  onChooseModel: () => void;
  onRetry: () => void;
}) {
  return (
    <article className={`liveErrorCard${notice.willRetry ? " retrying" : " terminal"}`} role={notice.willRetry ? "status" : "alert"}>
      <div>
        <strong>{notice.willRetry ? "模型请求正在重试" : "模型请求失败"}</strong>
        <span>{formatDateTime(notice.createdAt)}</span>
      </div>
      <p>{notice.message}</p>
      {notice.code ? <code>{notice.code}</code> : null}
      {!notice.willRetry ? (
        <div className="liveErrorActions">
          <button className="ghostButton" type="button" onClick={onChooseModel}>选择其他模型</button>
          {canRetry ? <button type="button" onClick={onRetry}>重试上一条消息</button> : null}
        </div>
      ) : null}
    </article>
  );
}

function LiveCommandCard({ command }: { command: LiveCommand }) {
  const completed = isLiveCommandCompleted(command);
  const runningOutput = completed ? command.output : tailText(command.output, MAX_LIVE_COMMAND_OUTPUT_CHARS);
  return (
    <article className={`commandCard ${completed ? "completed" : "running"}`}>
      <div className="commandHeader">
        <div>
          <strong>{completed ? "已完成" : "运行中"}</strong>
          <p className="muted">{command.cwd || "未知工作目录"}</p>
        </div>
        <button className="ghostButton" type="button" onClick={() => navigator.clipboard?.writeText(command.command)}>复制</button>
      </div>
      <pre className="commandText">{command.command}</pre>
      {completed ? (
        <details className="commandOutputDetails">
          <summary>查看输出（{command.output.length} 字符）</summary>
          <pre className="commandOutput completed">{command.output || "无输出"}</pre>
        </details>
      ) : (
        <pre className="commandOutput running">{runningOutput || "等待输出..."}</pre>
      )}
    </article>
  );
}

function isLiveCommandCompleted(command: LiveCommand): boolean {
  return command.status === "completed" || command.status === "succeeded" || command.exitCode !== null;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const hiddenChars = text.length - maxChars;
  return `已隐藏前 ${hiddenChars} 字符，仅展示最新输出\n\n${text.slice(-maxChars)}`;
}

function TaskInput({ runtime, onSend }: { runtime: RuntimeSnapshot | null; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const disabled = submitting || runtime?.status === "waiting_approval" || runtime?.status === "starting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextText = text.trim();
    if (!nextText || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSend(nextText);
      setText("");
    } catch {
      return;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!isTaskSendShortcut(event)) return;
    event.preventDefault();
    if (disabled || submittingRef.current || text.trim().length === 0) return;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className="taskInput" onSubmit={handleSubmit}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={runtime?.status === "waiting_approval" ? "请先处理审批" : "输入继续任务内容"}
        disabled={disabled}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        rows={3}
      />
      <button type="submit" disabled={disabled || text.trim().length === 0}>{submitting ? "发送中" : "发送"}</button>
    </form>
  );
}

function SessionCommandsPanel({
  commands,
  diagnostics,
  loading,
  error
}: {
  commands: SessionCommand[];
  diagnostics: SessionCommandDiagnostics | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <details className="commandsPanel" aria-labelledby="commands-title">
      <summary className="commandsSummary">
        <div>
          <h3 id="commands-title">历史命令</h3>
          <p className="muted">
            {loading ? "正在加载历史命令..." : `共 ${commands.length} 条命令`}
            {diagnostics && !diagnostics.matchedSessionFile ? "，未匹配到 JSONL 文件" : ""}
          </p>
        </div>
      </summary>
      <div className="commandsPanelBody">
        {error ? <div className="errorBanner">{error}</div> : null}
        {!loading && !error && commands.length === 0 ? <div className="emptyState">暂无历史命令</div> : null}
        {commands.length > 0 ? (
          <div className="commandList">
            {commands.map((command) => (
              <CommandCard command={command} key={command.callId} />
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function CommandCard({ command }: { command: SessionCommand }) {
  const completed = command.status === "completed";
  const output = command.output ?? "输出缺失，命令可能仍在运行或历史记录不完整。";

  async function copyCommand() {
    await navigator.clipboard?.writeText(command.cmd);
  }

  return (
    <article className={`commandCard ${command.status}`}>
      <div className="commandHeader">
        <div>
          <strong>{command.status === "completed" ? "已完成" : "运行中"}</strong>
          <p className="muted">{command.workdir || "未知工作目录"}</p>
        </div>
        <button className="ghostButton" type="button" onClick={copyCommand}>复制</button>
      </div>
      <pre className="commandText">{command.cmd}</pre>
      <div className="commandMeta">
        {command.sandboxPermissions ? <span>{command.sandboxPermissions}</span> : null}
        {command.justification ? <span>{command.justification}</span> : null}
        {command.prefixRule ? <span>prefix: {command.prefixRule.join(" ")}</span> : null}
        {command.tty ? <span>TTY</span> : null}
      </div>
      {completed ? (
        <details className="commandOutputDetails">
          <summary>查看输出（{command.outputLength} 字符）</summary>
          <pre className="commandOutput completed">{output}</pre>
        </details>
      ) : (
        <pre className="commandOutput running">{output}</pre>
      )}
    </article>
  );
}

function SessionTimeline({
  detail,
  visibleTurnCount,
  onLoadMore,
  onOpenMessage
}: {
  detail: SessionDetail;
  visibleTurnCount: number;
  onLoadMore: () => void;
  onOpenMessage: (message: { title: string; text: string; meta?: string }) => void;
}) {
  const hiddenTurnCount = Math.max(0, detail.turns.length - visibleTurnCount);
  const visibleTurns = detail.turns.slice(hiddenTurnCount);

  return (
    <div className="timeline" aria-label="历史消息">
      {hiddenTurnCount > 0 ? (
        <button className="ghostButton loadMoreButton" onClick={onLoadMore}>
          加载更早 {Math.min(DEFAULT_VISIBLE_TURNS, hiddenTurnCount)} 轮
        </button>
      ) : null}
      {visibleTurns.map((turn, visibleIndex) => {
        const absoluteIndex = hiddenTurnCount + visibleIndex;
        return (
          <section className="turnBlock" key={turn.id}>
            <div className="turnHeader">
              <h3>Turn {absoluteIndex + 1}</h3>
              <span>{turn.status}</span>
              <span>{formatDateTime(turn.startedAt)}</span>
            </div>
            <div className="turnItems">
              {turn.items.map((item) => (
                <TurnItemView item={item} key={item.id} onOpenMessage={onOpenMessage} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TurnItemView({
  item,
  onOpenMessage
}: {
  item: SessionTurnItem;
  onOpenMessage: (message: { title: string; text: string; meta?: string }) => void;
}) {
  switch (item.type) {
    case "user_message":
      return <MessageItem role="user" label="用户" text={item.text} onOpenMessage={onOpenMessage} />;
    case "agent_message":
      return <MessageItem role="agent" label="Codex" text={item.text} meta={item.phase ?? undefined} onOpenMessage={onOpenMessage} />;
    case "file_change":
      return (
        <article className="messageItem fileChangeItem">
          <div className="messageHeader">
            <strong>文件变更</strong>
            {item.status ? <span>{item.status}</span> : null}
          </div>
          <div className="fileChangeList">
            {item.changes.map((change, index) => (
              <details key={`${change.path}-${index}`}>
                <summary>
                  <span>{change.path}</span>
                  {change.kind ? <small>{change.kind}</small> : null}
                </summary>
                {change.diff ? <pre>{change.diff}</pre> : <p className="muted">无 diff</p>}
              </details>
            ))}
          </div>
        </article>
      );
    case "context_compaction":
      return <SystemItem text="上下文已压缩" />;
    case "unknown":
    default:
      return <SystemItem text={item.rawType ? `未识别事件：${item.rawType}` : "未识别事件"} />;
  }
}

function MessageItem({
  role,
  label,
  text,
  meta,
  onOpenMessage
}: {
  role: "user" | "agent";
  label: string;
  text: string;
  meta?: string;
  onOpenMessage: (message: { title: string; text: string; meta?: string }) => void;
}) {
  return (
    <button className={`messageItem ${role} messagePreview`} type="button" onClick={() => onOpenMessage({ title: label, text, meta })}>
      <div className="messageHeader">
        <strong>{label}</strong>
        {meta ? <span>{meta}</span> : null}
      </div>
      <div className="messageBody previewBody">
        <MarkdownContent text={text || "无内容"} />
      </div>
    </button>
  );
}

function MessageDetailDialog({ message, onClose }: { message: { title: string; text: string; meta?: string }; onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <section className="messageDialog" role="dialog" aria-modal="true" aria-label={`${message.title} 详情`} onClick={(event) => event.stopPropagation()}>
        <div className="dialogHeader">
          <div>
            <h2>{message.title}</h2>
            {message.meta ? <p className="muted">{message.meta}</p> : null}
          </div>
          <button className="ghostButton" onClick={onClose}>关闭</button>
        </div>
        <div className="dialogBody">
          <MarkdownContent text={message.text || "无内容"} />
        </div>
      </section>
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="markdownContent">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function SystemItem({ text }: { text: string }) {
  return <div className="systemItem">{text}</div>;
}

function SessionBrowser({
  sessions,
  search,
  loadingSessions,
  sessionError,
  selectedSessionId,
  showHeading = true,
  onSearchChange,
  onSearchSubmit,
  onRefresh,
  onSelect,
  onMetadataSaved
}: {
  sessions: SessionSummary[];
  search: string;
  loadingSessions: boolean;
  sessionError: string | null;
  selectedSessionId: string | null;
  showHeading?: boolean;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRefresh: () => void;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
}) {
  return (
    <>
      <div className={`sectionHeader${showHeading ? "" : " noHeading"}`}>
        {showHeading ? (
          <div>
            <h2>会话列表</h2>
            <p className="muted">共 {sessions.length} 个会话</p>
          </div>
        ) : null}
        <form className="searchForm" onSubmit={onSearchSubmit}>
          <input
            aria-label="搜索会话"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索 ID、标题、备注或工作目录"
          />
          <button type="submit">搜索</button>
          <button className="ghostButton" type="button" onClick={onRefresh} disabled={loadingSessions}>
            {loadingSessions ? "刷新中" : "刷新"}
          </button>
        </form>
      </div>

      {sessionError ? <div className="errorBanner">{sessionError}</div> : null}
      {loadingSessions ? <div className="emptyState">正在加载会话...</div> : null}
      {!loadingSessions && sessions.length === 0 ? <div className="emptyState">没有匹配的会话</div> : null}
      {!loadingSessions && sessions.length > 0 ? (
        <SessionList
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          onMetadataSaved={onMetadataSaved}
        />
      ) : null}
    </>
  );
}

function SessionList({
  sessions,
  selectedSessionId,
  onSelect,
  onMetadataSaved
}: {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
}) {
  const groups = groupSessionsByWorkspace(sessions);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());

  function toggleWorkspace(workspace: string) {
    setExpandedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(workspace)) {
        next.delete(workspace);
      } else {
        next.add(workspace);
      }
      return next;
    });
  }

  return (
    <div className="sessionList">
      {groups.map((group) => {
        const expanded = expandedWorkspaces.has(group.workspace);
        const visibleSessions = expanded ? group.sessions : group.sessions.slice(0, DEFAULT_VISIBLE_GROUP_SESSIONS);
        const hiddenCount = group.sessions.length - visibleSessions.length;

        return (
          <section className="sessionWorkspaceGroup" key={group.workspace} aria-label={`${group.workspace} 的会话`}>
            <div className="workspaceGroupHeader">
              <div>
                <h3>{group.workspace}</h3>
                <p className="muted">
                  {group.sessions.length} 个会话，默认显示最近 {Math.min(group.sessions.length, DEFAULT_VISIBLE_GROUP_SESSIONS)} 个
                </p>
              </div>
            </div>
            <div className="workspaceGroupList">
              {visibleSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  onSelect={onSelect}
                  onMetadataSaved={onMetadataSaved}
                />
              ))}
            </div>
            {group.sessions.length > DEFAULT_VISIBLE_GROUP_SESSIONS ? (
              <button className="ghostButton workspaceToggleButton" type="button" onClick={() => toggleWorkspace(group.workspace)}>
                {expanded ? "收起" : `展开更多 ${hiddenCount} 个会话`}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function groupSessionsByWorkspace(sessions: SessionSummary[]): { workspace: string; sessions: SessionSummary[] }[] {
  const groups = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    const workspace = session.workspace.trim() || "未知工作目录";
    const group = groups.get(workspace);
    if (group) {
      group.push(session);
    } else {
      groups.set(workspace, [session]);
    }
  }

  return [...groups.entries()].map(([workspace, groupedSessions]) => ({
    workspace,
    sessions: groupedSessions
  }));
}

function SessionItem({
  session,
  selected,
  onSelect,
  onMetadataSaved
}: {
  session: SessionSummary;
  selected: boolean;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.remarkTitle ?? session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipTitleBlurRef = useRef(false);

  useEffect(() => {
    if (!editingTitle) {
      setTitleDraft(session.remarkTitle ?? session.title);
    }
  }, [editingTitle, session.remarkTitle, session.title]);

  async function saveRemark(nextTitle: string | null) {
    if ((session.remarkTitle ?? null) === nextTitle) return;

    setSaving(true);
    setError(null);

    try {
      const response = await updateSessionMetadata(session.id, nextTitle);
      onMetadataSaved(response.session);
      setTitleDraft(response.session.remarkTitle ?? response.session.title);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "备注保存失败");
    } finally {
      setSaving(false);
    }
  }

  function beginTitleEdit() {
    setError(null);
    setTitleDraft(session.remarkTitle ?? session.title);
    setEditingTitle(true);
  }

  function cancelTitleEdit() {
    skipTitleBlurRef.current = true;
    setTitleDraft(session.remarkTitle ?? session.title);
    setEditingTitle(false);
  }

  function finishTitleEdit() {
    if (skipTitleBlurRef.current) {
      skipTitleBlurRef.current = false;
      return;
    }

    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    const nextTitle = trimmed.length === 0 || (!session.remarkTitle && trimmed === session.defaultTitle) ? null : trimmed;
    saveRemark(nextTitle);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelTitleEdit();
    }
  }

  return (
    <article className={`sessionItem${selected ? " selected" : ""}`}>
      <div className="sessionMain">
        <div className="sessionTitleRow">
          {editingTitle ? (
            <input
              className="titleEditInput"
              aria-label={`设置 ${session.title} 的备注标题`}
              autoFocus
              maxLength={120}
              value={titleDraft}
              onBlur={finishTitleEdit}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={handleTitleKeyDown}
            />
          ) : (
            <button
              className="titleEditButton"
              type="button"
              aria-label={`编辑 ${session.title} 的备注标题`}
              title={session.defaultTitle}
              onClick={beginTitleEdit}
              disabled={saving}
            >
              <span>{session.title}</span>
              <small className="titleEditIcon" aria-hidden="true">{saving ? "…" : "✎"}</small>
            </button>
          )}
          <StatusBadge status={session.status} />
        </div>
        {session.remarkTitle ? <p className="remarkHint">默认标题：{session.defaultTitle}</p> : null}
        <p className="sessionSummary">{session.summary}</p>
        <div className="sessionMeta">
          <span>{session.workspace}</span>
          <span>{formatDateTime(session.updatedAt)}</span>
        </div>
        {error ? <div className="errorText">{error}</div> : null}
      </div>
      <div className="sessionActions">
        <button className="ghostButton" onClick={() => onSelect(session)}>
          {selected ? "已选择" : "进入"}
        </button>
        <div className="sessionId" title={session.id}>
          {session.id}
        </div>
      </div>
    </article>
  );
}


type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string | null; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  }

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(.*)$/);
    if (fence) {
      flushParagraph();
      const language = fence[1]?.trim() || null;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, text: code.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const items: string[] = [];
      const orderedList = Boolean(ordered);
      while (index < lines.length) {
        const itemLine = lines[index].trim();
        const item = orderedList ? itemLine.match(/^\d+[.)]\s+(.+)$/) : itemLine.match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ type: "list", ordered: orderedList, items });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks.length > 0 ? blocks : [{ type: "paragraph", text }];
}

function renderMarkdownBlock(block: MarkdownBlock, index: number) {
  switch (block.type) {
    case "heading": {
      const Heading = (`h${block.level + 2}` as "h3" | "h4" | "h5");
      return <Heading key={index}>{renderInlineMarkdown(block.text)}</Heading>;
    }
    case "code":
      return (
        <pre className="markdownCode" key={index}>
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={index}>{renderInlineMarkdown(block.text)}</blockquote>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </List>
      );
    }
    case "paragraph":
    default:
      return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
  }
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(...renderLineBreaks(text.slice(cursor, match.index), nodes.length));
    const token = match[0];
    nodes.push(renderInlineToken(token, nodes.length));
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(...renderLineBreaks(text.slice(cursor), nodes.length));
  return nodes;
}

function renderLineBreaks(text: string, startIndex: number): ReactNode[] {
  const parts = text.split("\n");
  return parts.flatMap((part, index) => (index === 0 ? [part] : [<br key={`br-${startIndex}-${index}`} />, part]));
}

function renderInlineToken(token: string, key: number): ReactNode {
  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    const href = link[2];
    const safeHref = /^https?:\/\//.test(href) ? href : undefined;
    return safeHref ? (
      <a href={safeHref} key={key} target="_blank" rel="noreferrer">
        {link[1]}
      </a>
    ) : (
      <span key={key}>{link[1]}</span>
    );
  }

  if (token.startsWith("`") && token.endsWith("`")) return <code key={key}>{token.slice(1, -1)}</code>;
  if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
    return <strong key={key}>{token.slice(2, -2)}</strong>;
  }
  if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
    return <em key={key}>{token.slice(1, -1)}</em>;
  }
  return token;
}

function StatusBadge({ status }: { status: SessionStatus }) {
  return <span className={`statusBadge ${status}`}>{statusLabel(status)}</span>;
}

function Shell({
  title,
  action,
  children,
  reserveFloatingStatus = false
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  reserveFloatingStatus?: boolean;
}) {
  return (
    <main className={`appShell${reserveFloatingStatus ? " reserveFloatingStatus" : ""}`}>
      <header className="topbar">
        <h1>{title}</h1>
        {action}
      </header>
      <div className="content">{children}</div>
    </main>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="infoItem">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function emptyModelState(): SessionModelState {
  return {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    updatedAt: null,
    actualModel: null,
    actualModelProvider: null,
    actualReasoningEffort: null,
    actualModelSupported: null,
    applied: false,
    confirmationPending: false,
    lastError: null
  };
}

function modelChangeStatusLabel(status: RuntimeSnapshot["modelChangeStatus"]): string {
  switch (status) {
    case "pending":
      return "正在请求";
    case "confirming":
      return "等待确认";
    case "applied":
      return "已应用";
    case "failed":
      return "失败";
    case "idle":
    default:
      return "空闲";
  }
}

function wsStatusLabel(status: WebSocketStatus): string {
  switch (status) {
    case "connected":
      return "实时已连接";
    case "connecting":
      return "实时连接中";
    case "disconnected":
      return "实时已断开";
    case "idle":
    default:
      return "实时未连接";
  }
}

function appServerStatusLabel(status: NonNullable<PublicConfig["appServer"]>["status"]): string {
  switch (status) {
    case "ready":
      return "运行正常";
    case "starting":
      return "启动中";
    case "failed":
      return "启动失败";
    case "exited":
      return "已退出";
    case "idle":
    default:
      return "未启动";
  }
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!value || typeof value !== "object") return false;
  const runtime = value as RuntimeSnapshot;
  return typeof runtime.threadId === "string" && (runtime.permissionMode === "default" || runtime.permissionMode === "full_access");
}

function isApprovalSummary(value: unknown): value is ApprovalSummary {
  return Boolean(value && typeof value === "object" && typeof (value as ApprovalSummary).id === "string");
}

function readPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRealtimeErrorMessage(payload: Record<string, unknown>): string | null {
  const direct = readPayloadString(payload.message);
  if (direct) return direct;
  if (!payload.error || typeof payload.error !== "object") return readPayloadString(payload.error);
  const error = payload.error as Record<string, unknown>;
  return readPayloadString(error.message) ?? readPayloadString(error.error);
}

function readPayloadNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((current) => current.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = { ...next[index], ...item };
  return next;
}

function appendLiveMessage(messages: LiveMessage[], nextMessage: LiveMessage): LiveMessage[] {
  const current = messages.find((message) => message.id === nextMessage.id);
  if (!current) return [...messages, nextMessage];
  return messages.map((message) => (message.id === nextMessage.id ? { ...message, text: `${message.text}${nextMessage.text}` } : message));
}

function updateLiveMessageDeliveryStatus(
  messages: LiveMessage[],
  messageId: string,
  deliveryStatus: Exclude<LiveMessage["deliveryStatus"], null>
): LiveMessage[] {
  return messages.map((message) => (message.id === messageId ? { ...message, deliveryStatus } : message));
}

function deliveryStatusLabel(status: Exclude<LiveMessage["deliveryStatus"], null>): string {
  switch (status) {
    case "sending":
      return "发送中";
    case "sent":
      return "已发送";
    case "failed":
      return "发送失败";
  }
}

function createLocalMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-${crypto.randomUUID()}`;
  }
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function appendCommandOutput(commands: LiveCommand[], itemId: string, delta: string): LiveCommand[] {
  const current = commands.find((command) => command.id === itemId);
  if (!current) {
    return [
      ...commands,
      { id: itemId, itemId, turnId: null, command: "", cwd: "", status: "running", output: delta, exitCode: null, durationMs: null }
    ];
  }
  return commands.map((command) => (command.id === itemId ? { ...command, output: `${command.output}${delta}` } : command));
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "waiting_input":
      return "待输入";
    case "waiting_approval":
      return "待审批";
    case "exited":
      return "已退出";
    case "failed":
      return "失败";
    case "history":
    default:
      return "历史";
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
