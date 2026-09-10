import { CSSProperties, ChangeEvent, FormEvent, Fragment, KeyboardEvent, PointerEvent, ReactNode, RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, branchSession, continueSessionFromHistory, createCollaborator, createSession, getCollaborators, getHealthStatus, getLoginAccounts, getMe, getModels, getPublicConfig, getSessionDetail, getSessionRuntime, getSessionWebSocketUrl, getSessions, login, logout, reloadRuntime, resumeSession, sendSessionInput, submitApproval, updateCollaboratorGrants, updateCollaboratorStatus, updateSessionMetadata, updateSessionModel, uploadSessionAttachment, type UploadedSessionAttachment } from "../shared/api";
import type { ApprovalDecision, ApprovalSummary, Collaborator, HealthStatus, LoginAccount, ModelCatalogResponse, PublicConfig, RuntimeSnapshot, SessionBranchMode, SessionDetail, SessionModelState, SessionPermissionMode, SessionSummary, SessionStatus, SessionTurnItem, UpdateModelSelectionInput, UserIdentity, UserSession, WebSessionEvent } from "../shared/models";
import { ModelSelector } from "./ModelSelector";
import { modelStateAfterRuntimeSnapshot, modelSwitchDisabledReason } from "./modelSelection";
import { findRetryContextForTurn, findRetryContextFromFailedTurns, isCommentaryPhase, isFinalAnswerPhase, isTaskSendShortcut, isUnmaterializedThreadHistoryError, type RetryContext } from "./sessionInteractions";
import { buildSessionDetailPath, parseSessionRoute, type SessionRoute } from "./sessionRoute";
import { stripAmbientBrowserContext } from "../shared/messageText";
import { clearBootstrapSession, readBootstrapSession, writeBootstrapSession } from "./bootstrapSession";

type LoadState = "loading" | "ready" | "error";
type WebSocketStatus = "idle" | "connecting" | "connected" | "disconnected";
type DashboardView = "list" | "settings" | "members" | "detail" | "invalid";
type SessionListMode = "workspace" | "recent";

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
  turnId: string | null;
  message: string;
  code: string | null;
  willRetry: boolean;
  createdAt: string;
  retryContext: RetryContext | null;
};

type LiveTimelineEntry = {
  kind: "message" | "command" | "error";
  id: string;
};

type SendInputOptions = {
  isRetry?: boolean;
};


export function App() {
  const [bootstrapSession] = useState(() => readBootstrapSession());
  const [loadState, setLoadState] = useState<LoadState>(bootstrapSession ? "ready" : "loading");
  const [session, setSession] = useState<UserSession | null>(bootstrapSession);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const me = await getMe();
        if (cancelled) return;
        setSession(me);
        if (me.authenticated) writeBootstrapSession(me);
        else clearBootstrapSession();

        if (me.authenticated && me.user?.role !== "child") {
          const publicConfig = await getPublicConfig();
          if (cancelled) return;
          setConfig(publicConfig);
        }

        setLoadState("ready");
      } catch (caught) {
        if (cancelled) return;
        if (bootstrapSession) return;
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
    writeBootstrapSession(nextSession);
    setConfig(nextSession.user?.role === "child" ? null : await getPublicConfig());
  }

  async function handleLogout() {
    const nextSession = await logout();
    setSession(nextSession);
    clearBootstrapSession();
    setConfig(null);
  }

  if (loadState === "loading") {
    return <Shell title="Codex Manage">正在载入...</Shell>;
  }

  if (loadState === "error") {
    return <Shell title="Codex Manage">{error}</Shell>;
  }

  if (!session?.authenticated) {
    return <LoginView onLoggedIn={handleLoggedIn} />;
  }

  return <Dashboard user={session.user ?? ownerFallbackIdentity()} config={config} onLogout={handleLogout} />;
}

function LoginView({
  onLoggedIn
}: {
  onLoggedIn: (session: UserSession) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [accountId, setAccountId] = useState("owner");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getLoginAccounts().then((response) => setAccounts(response.accounts)).catch(() => setAccounts([]));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const session = await login(password, accountId);
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

        <form className="loginForm" onSubmit={handleSubmit}>
          {accounts.length > 0 ? (
            <div className="loginAccounts" aria-label="选择登录账号">
              <span className="loginFieldLabel">账号</span>
              {accounts.map((account) => (
                <button
                  className={`loginAccountOption${account.id === accountId ? " selected" : ""}`}
                  type="button"
                  key={account.id}
                  onClick={() => setAccountId(account.id)}
                >
                  <span className="accountAvatar">{account.displayName.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{account.displayName}</strong>
                    <small>{account.localEmail ?? (account.role === "owner" ? "Owner account" : "Child user")}</small>
                  </span>
                  {account.id === accountId ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
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

function ownerFallbackIdentity(): UserIdentity {
  return {
    id: "owner",
    role: "owner",
    displayName: "Owner",
    localEmail: null,
    active: true,
    ownerUserId: null
  };
}

function Dashboard({
  user,
  config,
  onLogout
}: {
  user: UserIdentity;
  config: PublicConfig | null;
  onLogout: () => Promise<void>;
}) {
  const [initialRoute] = useState(() => parseSessionRoute(window.location.pathname));
  const safeInitialRoute = user.role === "child" && (initialRoute.kind === "settings" || initialRoute.kind === "members")
    ? ({ kind: "list" } as const)
    : initialRoute;
  const [currentConfig, setCurrentConfig] = useState(config);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(safeInitialRoute.kind === "settings" && user.role === "owner");
  const [reloadingRuntime, setReloadingRuntime] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [runtimeReloadNotice, setRuntimeReloadNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [creatingSessionWorkspace, setCreatingSessionWorkspace] = useState<string | null>(null);
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    safeInitialRoute.kind === "detail" ? safeInitialRoute.sessionId : null
  );
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(safeInitialRoute.kind === "detail");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [historyLoadedSessionId, setHistoryLoadedSessionId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DashboardView>(safeInitialRoute.kind === "list" ? "list" : safeInitialRoute.kind);
  const [routeError, setRouteError] = useState<string | null>(safeInitialRoute.kind === "invalid" ? safeInitialRoute.message : null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [permissionMode, setPermissionMode] = useState<SessionPermissionMode>("default");
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalSummary[]>([]);
  const [liveCommands, setLiveCommands] = useState<LiveCommand[]>([]);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);
  const [liveErrors, setLiveErrors] = useState<LiveErrorNotice[]>([]);
  const [liveTimeline, setLiveTimeline] = useState<LiveTimelineEntry[]>([]);
  const [wsStatus, setWsStatus] = useState<WebSocketStatus>("idle");
  const [wsReconnectKey, setWsReconnectKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [branchingMode, setBranchingMode] = useState<SessionBranchMode | null>(null);
  const [historyContinuationPending, setHistoryContinuationPending] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [modelActionError, setModelActionError] = useState<string | null>(null);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [retryContext, setRetryContext] = useState<RetryContext | null>(null);
  const [retryDialogOpen, setRetryDialogOpen] = useState(false);
  const lastEventSeqRef = useRef(0);
  const runtimeEventSeqRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(safeInitialRoute.kind === "detail" ? safeInitialRoute.sessionId : null);
  const historyLoadedSessionIdRef = useRef<string | null>(null);
  const historyLoadingSessionIdRef = useRef<string | null>(null);
  const sessionDetailRef = useRef<SessionDetail | null>(null);
  const liveMessagesRef = useRef<LiveMessage[]>([]);
  const liveTimelineRef = useRef<LiveTimelineEntry[]>([]);
  const retryContextRef = useRef<RetryContext | null>(null);
  const runtimeReloadGenerationRef = useRef<number | null>(null);
  const resolvedApprovalIdsRef = useRef(new Set<string>());
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compactViewport = useCompactViewport();
  const completionRefreshInFlightRef = useRef(new Set<string>());
  const sessionDetailRequestsRef = useRef(new Map<string, Promise<{ session: SessionDetail }>>());
  const searchRef = useRef("");

  const selectedSession = sessions.find((session) => isSameSession(session, selectedSessionId))
    ?? (isSameSession(sessionDetail, selectedSessionId) ? sessionDetail : null);
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

  async function handleReloadRuntime() {
    setReloadingRuntime(true);
    setDiagnosticsError(null);

    try {
      await reloadRuntime();
      await loadDiagnostics();
    } catch (caught) {
      setDiagnosticsError(caught instanceof Error ? caught.message : "Codex 运行时刷新失败");
    } finally {
      setReloadingRuntime(false);
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
    if (user.role !== "owner") return;
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
    if (safeInitialRoute.kind === "detail") {
      void refreshCurrentSession(safeInitialRoute.sessionId);
    }
    if (safeInitialRoute.kind === "settings" && user.role === "owner") {
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
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    if (!isStandalonePwa()) return;

    let wasHidden = document.visibilityState === "hidden";

    function refreshAfterResume() {
      if (document.visibilityState !== "visible") return;
      void loadSessions(searchRef.current);
      const sessionId = selectedSessionIdRef.current;
      if (sessionId) {
        void refreshCurrentSession(sessionId, {
          silent: true,
          includeTurns: historyLoadedSessionIdRef.current === sessionId
        });
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      refreshAfterResume();
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) refreshAfterResume();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(() => {
    liveMessagesRef.current = liveMessages;
  }, [liveMessages]);

  useEffect(() => {
    sessionDetailRef.current = sessionDetail;
  }, [sessionDetail]);

  useEffect(() => {
    retryContextRef.current = retryContext;
  }, [retryContext]);

  useEffect(() => {
    if (runtime?.status !== "failed" || !sessionDetail || historyLoadedSessionId !== sessionDetail.id || retryContextRef.current) return;
    const restored = findRetryContextFromFailedTurns(sessionDetail.turns);
    if (!restored) return;
    retryContextRef.current = restored;
    setRetryContext(restored);
  }, [historyLoadedSessionId, runtime?.status, sessionDetail]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => drawerCloseRef.current?.focus(), 0);

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key === "Tab") keepFocusInside(event, drawerRef.current);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      drawerTriggerRef.current?.focus();
    };
  }, [drawerOpen]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loadSessions(search);
  }

  async function loadSessionDetail(sessionId: string, options: { silent?: boolean; includeTurns?: boolean } = {}): Promise<SessionDetail | null> {
    const includeTurns = options.includeTurns ?? false;
    if (includeTurns && historyLoadingSessionIdRef.current === sessionId) return null;
    if (includeTurns) historyLoadingSessionIdRef.current = sessionId;
    if (!options.silent) {
      if (includeTurns) setLoadingHistory(true);
      else setLoadingDetail(true);
    }
    if (includeTurns) {
      setHistoryError(null);
      setHistoryNotice(null);
    }
    else setDetailError(null);

    try {
      const requestKey = `${sessionId}:${includeTurns ? "turns" : "summary"}`;
      let request = sessionDetailRequestsRef.current.get(requestKey);
      if (!request) {
        request = getSessionDetail(sessionId, includeTurns);
        sessionDetailRequestsRef.current.set(requestKey, request);
        void request.then(() => {
          if (sessionDetailRequestsRef.current.get(requestKey) === request) {
            sessionDetailRequestsRef.current.delete(requestKey);
          }
        }, () => {
          if (sessionDetailRequestsRef.current.get(requestKey) === request) {
            sessionDetailRequestsRef.current.delete(requestKey);
          }
        });
      }
      const response = await request;
      if (selectedSessionIdRef.current !== sessionId) return null;
      setSessionDetail(response.session);
      if (includeTurns) {
        historyLoadedSessionIdRef.current = sessionId;
        setHistoryLoadedSessionId(sessionId);
        setHistoryNotice(null);
        reconcileLiveMessagesWithHistory(response.session);
      }
      return response.session;
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return null;
      const message = caught instanceof Error ? caught.message : includeTurns ? "历史会话加载失败" : "会话详情加载失败";
      if (includeTurns) {
        if (isUnmaterializedThreadHistoryError(message)) {
          setHistoryNotice("新会话已创建，可以正常开始对话。发送第一条消息后，历史消息会显示在这里。");
          return null;
        }
        setHistoryError(message);
      } else {
        if (!options.silent) setSessionDetail(null);
        setDetailError(message);
      }
      return null;
    } finally {
      if (includeTurns && historyLoadingSessionIdRef.current === sessionId) {
        historyLoadingSessionIdRef.current = null;
      }
      if (!options.silent && selectedSessionIdRef.current === sessionId) {
        if (includeTurns) {
          setLoadingHistory(false);
          setLoadingDetail(false);
        }
        else setLoadingDetail(false);
      }
    }
  }

  function registerLiveTimelineEntry(kind: LiveTimelineEntry["kind"], id: string) {
    if (liveTimelineRef.current.some((entry) => entry.kind === kind && entry.id === id)) return;
    const next = [...liveTimelineRef.current, { kind, id }];
    liveTimelineRef.current = next;
    setLiveTimeline(next);
  }

  function replaceLiveTimelineEntry(kind: LiveTimelineEntry["kind"], previousId: string, nextId: string) {
    const next = liveTimelineRef.current
      .filter((entry) => !(entry.kind === kind && entry.id === previousId))
      .concat(liveTimelineRef.current.some((entry) => entry.kind === kind && entry.id === nextId) ? [] : [{ kind, id: nextId }]);
    liveTimelineRef.current = next;
    setLiveTimeline(next);
  }

  function reconcileLiveMessagesWithHistory(history: SessionDetail, dropUnmatchedAgentMessages = false) {
    const historicalTurns = history.turns;
    const historicalTurnIds = new Set(historicalTurns.map((turn) => turn.id));
    const historicalItemIds = new Set(historicalTurns.flatMap((turn) => turn.items.map((item) => item.id)));
    const removedMessageIds = new Set<string>();
    const retainedMessages = liveMessagesRef.current.filter((message) => {
      const belongsToHistory = Boolean(message.itemId && historicalItemIds.has(message.itemId))
        || Boolean(message.turnId && historicalTurnIds.has(message.turnId))
        || (message.role === "user" && Boolean(message.turnId) && historicalTurns.some((turn) => turn.id === message.turnId
          && turn.items.some((item): item is Extract<SessionTurnItem, { type: "user_message" }> => item.type === "user_message"
            && stripAmbientBrowserContext(item.text) === stripAmbientBrowserContext(message.text))));
      const shouldRemove = belongsToHistory || (dropUnmatchedAgentMessages && message.role === "agent");
      if (shouldRemove) removedMessageIds.add(message.id);
      return !shouldRemove;
    });
    if (removedMessageIds.size === 0) return;

    liveMessagesRef.current = retainedMessages;
    setLiveMessages(retainedMessages);
    const retainedTimeline = liveTimelineRef.current.filter((entry) => !(entry.kind === "message" && removedMessageIds.has(entry.id)));
    liveTimelineRef.current = retainedTimeline;
    setLiveTimeline(retainedTimeline);
  }

  function syncRuntimeSnapshot(nextRuntime: RuntimeSnapshot) {
    if (nextRuntime.eventSeq < runtimeEventSeqRef.current) return false;
    runtimeEventSeqRef.current = nextRuntime.eventSeq;
    setRuntime(nextRuntime);
    setSessionDetail((current) => current && isSameSession(current, nextRuntime.threadId)
      ? {
          ...current,
          status: nextRuntime.status,
          modelState: modelStateAfterRuntimeSnapshot(current.modelState, nextRuntime)
        }
      : current);
    setSessions((current) => current.map((session) => isSameSession(session, nextRuntime.threadId)
      ? { ...session, status: nextRuntime.status }
      : session));
    setPermissionMode(nextRuntime.permissionMode);
    return true;
  }

  async function loadRuntime(sessionId: string, options: { silent?: boolean } = {}): Promise<RuntimeSnapshot | null> {
    if (!options.silent) setRuntimeError(null);
    try {
      const response = await getSessionRuntime(sessionId);
      if (selectedSessionIdRef.current !== sessionId) return null;
      syncRuntimeSnapshot(response.runtime);
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, response.runtime.eventSeq);
      return response.runtime;
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return null;
      if (!options.silent) setRuntimeError(caught instanceof Error ? caught.message : "运行状态加载失败");
      return null;
    }
  }

  async function refreshCurrentSession(sessionId: string, options: { silent?: boolean; includeTurns?: boolean } = {}) {
    const includeTurns = options.includeTurns ?? true;
    await Promise.all([
      loadSessionDetail(sessionId, {
        ...options,
        includeTurns
      }),
      loadRuntime(sessionId, options)
    ]);
  }

  async function refreshAfterTurnCompleted(sessionId: string) {
    if (completionRefreshInFlightRef.current.has(sessionId)) return;
    completionRefreshInFlightRef.current.add(sessionId);
    // The JSONL/thread view is committed just after the completion event. Retry
    // once after the commit boundary so the UI does not require a browser refresh.
    try {
      for (const waitMs of [120, 500]) {
        await delay(waitMs);
        if (selectedSessionIdRef.current !== sessionId) return;
        await Promise.all([
          loadSessionDetail(sessionId, { silent: true, includeTurns: true }),
          loadSessions(search)
        ]).then(([history]) => {
          if (history) reconcileLiveMessagesWithHistory(history, true);
        });
      }
    } finally {
      completionRefreshInFlightRef.current.delete(sessionId);
    }
  }

  async function pollCurrentSessionAfterInput(sessionId: string) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await delay(attempt === 0 ? 800 : 2000);
      if (selectedSessionIdRef.current !== sessionId) return;
      const nextRuntime = await loadRuntime(sessionId, { silent: true });
      if (nextRuntime && ["waiting_input", "exited", "failed"].includes(nextRuntime.status)) {
        await refreshAfterTurnCompleted(sessionId);
        return;
      }
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
      setSessionDetail((current) => current && isSameSession(current, sessionId)
        ? { ...current, modelState: response.selection }
        : current);
      setModelPickerOpen(false);
      if (retryContextRef.current) setRetryDialogOpen(true);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return;
      const message = caught instanceof Error ? caught.message : "模型切换失败";
      setModelActionError(message);
      setLiveErrors((current) => upsertById(current, {
        id: `model-action-${sessionId}`,
        turnId: null,
        message,
        code: "MODEL_SWITCH_FAILED",
        willRetry: false,
        createdAt: new Date().toISOString(),
        retryContext: null
      }));
      await loadRuntime(sessionId, { silent: true });
    } finally {
      setUpdatingModel(false);
    }
  }

  async function handleRetryLastMessage() {
    if (!retryContext) return;
    await handleSendInput(retryContext.text, { isRetry: true });
    setRetryDialogOpen(false);
    setRetryContext(null);
    retryContextRef.current = null;
  }

  function applyRealtimeEvent(event: WebSessionEvent) {
    if (selectedSessionIdRef.current !== event.threadId) return;
    if (event.seq <= lastEventSeqRef.current) return;
    lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
    const payload = event.payload as Record<string, unknown>;

    if (event.type === "session_status" && isRuntimeSnapshot(payload.runtime)) {
      const nextRuntime = payload.runtime;
      syncRuntimeSnapshot(nextRuntime);
      if (["waiting_input", "exited", "failed"].includes(nextRuntime.status)) {
        void refreshAfterTurnCompleted(event.threadId);
      }
      return;
    }

    if (event.type === "turn_completed") {
      void refreshAfterTurnCompleted(event.threadId);
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
      if (retryContextRef.current) setRetryDialogOpen(true);
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
      const errorId = `model-change-${event.threadId}`;
      registerLiveTimelineEntry("error", errorId);
      setLiveErrors((current) => upsertById(current, {
        id: errorId,
        turnId: null,
        message,
        code,
        willRetry: false,
        createdAt: event.createdAt,
        retryContext: null
      }));
      return;
    }

    if (event.type === "error") {
      const message = readRealtimeErrorMessage(payload) ?? "Codex 执行失败";
      const willRetry = payload.willRetry === true;
      const turnId = readPayloadString(payload.turnId);
      const errorCode = readPayloadString(payload.errorCode);
      const activeWriter = errorCode === "SESSION_ACTIVE_WRITER" || isActiveWriterMessage(message);
      const retryingId = `retrying-${event.threadId}-${turnId}`;
      const retryContext = willRetry
        ? null
        : findRetryContextForTurn(turnId, liveMessagesRef.current, sessionDetailRef.current?.turns ?? [])
          ?? (activeWriter ? retryContextRef.current : null);
      if (willRetry) {
        registerLiveTimelineEntry("error", retryingId);
      } else {
        replaceLiveTimelineEntry("error", retryingId, `terminal-${event.seq}`);
      }
      setLiveErrors((current) => willRetry
        ? upsertById(current, {
            id: retryingId,
            turnId,
            message,
            code: errorCode,
            willRetry,
            createdAt: event.createdAt,
            retryContext: null
          })
        : [
            ...current.filter((item) => item.id !== retryingId),
            {
              id: `terminal-${event.seq}`,
              turnId,
              message,
              code: activeWriter ? "SESSION_ACTIVE_WRITER" : errorCode,
              willRetry: false,
              createdAt: event.createdAt,
              retryContext
            }
          ]);
      if (!willRetry) {
        if (retryContext) {
          retryContextRef.current = retryContext;
          setRetryContext(retryContext);
        }
      }
      return;
    }

    if (event.type === "approval_requested" && isApprovalSummary(payload.approval)) {
      const approval = payload.approval;
      if (resolvedApprovalIdsRef.current.has(approval.id)) return;
      setPendingApprovals((current) => upsertById(current, approval));
      return;
    }

    if (event.type === "approval_resolved" && isApprovalSummary(payload.approval)) {
      const approval = payload.approval;
      resolvedApprovalIdsRef.current.add(approval.id);
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      return;
    }

    if (event.type === "agent_message_delta") {
      const itemId = readPayloadString(payload.itemId) ?? `${event.seq}`;
      const turnId = readPayloadString(payload.turnId);
      const delta = readPayloadString(payload.delta) ?? "";
      registerLiveTimelineEntry("message", itemId);
      setLiveMessages((current) => {
        const next = appendLiveMessage(current, {
          id: itemId,
          role: "agent",
          itemId,
          turnId,
          text: delta,
          deliveryStatus: null
        });
        liveMessagesRef.current = next;
        return next;
      });
      return;
    }

    if (event.type === "command_started") {
      const itemId = readPayloadString(payload.itemId) ?? `${event.seq}`;
      registerLiveTimelineEntry("command", itemId);
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
      registerLiveTimelineEntry("command", itemId);
      setLiveCommands((current) => appendCommandOutput(current, itemId, delta));
      return;
    }

    if (event.type === "command_completed") {
      const itemId = readPayloadString(payload.itemId) ?? `${event.seq}`;
      registerLiveTimelineEntry("command", itemId);
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
    if (sessionId) completionRefreshInFlightRef.current.delete(sessionId);
    setSelectedSessionId(sessionId);
    setSessionDetail(null);
    historyLoadedSessionIdRef.current = null;
    historyLoadingSessionIdRef.current = null;
    setHistoryLoadedSessionId(null);
    setLoadingHistory(false);
    setHistoryError(null);
    setHistoryNotice(null);
    setRuntime(null);
    setPermissionMode("default");
    setPendingApprovals([]);
    setLiveCommands([]);
    setLiveMessages([]);
    liveMessagesRef.current = [];
    setLiveErrors([]);
    setLiveTimeline([]);
    liveTimelineRef.current = [];
    setRuntimeError(null);
    setSessionNotice(null);
    setBranchingMode(null);
    setModelActionError(null);
    setModelPickerOpen(false);
    setRetryContext(null);
    retryContextRef.current = null;
    setRetryDialogOpen(false);
    lastEventSeqRef.current = 0;
    runtimeEventSeqRef.current = 0;
    resolvedApprovalIdsRef.current.clear();
  }

  function applySessionRoute(route: SessionRoute) {
    if (route.kind === "list") {
      setRouteError(null);
      setViewMode("list");
      return;
    }

    if (route.kind === "settings") {
      if (user.role !== "owner") {
        setViewMode("list");
        return;
      }
      setDrawerOpen(false);
      setRouteError(null);
      setViewMode("settings");
      void loadDiagnostics();
      return;
    }

    if (route.kind === "members") {
      if (user.role !== "owner") {
        setViewMode("list");
        return;
      }
      setDrawerOpen(false);
      setRouteError(null);
      setViewMode("members");
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

  async function handleCreateSession(workspace: string) {
    if (user.role !== "owner" || creatingSessionWorkspace) return;
    setCreatingSessionWorkspace(workspace);
    setCreateSessionError(null);
    try {
      const response = await createSession(workspace);
      await loadSessions("");
      const path = buildSessionDetailPath(response.threadId);
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
      applySessionRoute({ kind: "detail", sessionId: response.threadId });
    } catch (caught) {
      setCreateSessionError(caught instanceof Error ? caught.message : "新会话创建失败");
    } finally {
      setCreatingSessionWorkspace(null);
    }
  }

  function handleMetadataSaved(updated: SessionSummary) {
    setSessions((current) => current.map((session) => (isSameSession(session, updated.id) ? updated : session)));
    setSessionDetail((current) => (current && isSameSession(current, updated.id) ? { ...current, ...updated } : current));
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
        if (event.seq < lastEventSeqRef.current) return;
        const payload = event.payload as Record<string, unknown>;
        if (isRuntimeSnapshot(payload.runtime)) syncRuntimeSnapshot(payload.runtime);
        if (Array.isArray(payload.approvals)) {
          setPendingApprovals(payload.approvals.filter(isApprovalSummary).filter((approval) => !resolvedApprovalIdsRef.current.has(approval.id)));
        }
        if (Array.isArray(payload.events)) {
          payload.events
            .filter((item): item is WebSessionEvent => Boolean(item && typeof item === "object"))
            .sort((left, right) => left.seq - right.seq)
            .forEach((item) => applyRealtimeEvent(item));
        }
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

  async function handleSendInput(text: string, options: SendInputOptions = {}) {
    if (!selectedSessionId) return;
    await sendInputToSession(selectedSessionId, text, permissionMode, options);
  }

  async function sendInputToSession(
    sessionId: string,
    text: string,
    nextPermissionMode: SessionPermissionMode,
    options: SendInputOptions = {}
  ): Promise<void> {
    if (!options.isRetry) {
      setRetryDialogOpen(false);
      setRetryContext(null);
      retryContextRef.current = null;
    }
    const messageId = createLocalMessageId();
    const localMessage: LiveMessage = {
      id: messageId,
      role: "user",
      turnId: null,
      itemId: null,
      text,
      deliveryStatus: "sending"
    };
    registerLiveTimelineEntry("message", messageId);
    setRuntimeError(null);
    if (!options.isRetry) setSessionNotice(null);
    liveMessagesRef.current = [...liveMessagesRef.current, localMessage];
    setLiveMessages((current) => [...current, localMessage]);
    try {
      const response = await sendSessionInput(sessionId, text, nextPermissionMode);
      if (selectedSessionIdRef.current !== sessionId) return;
      const acknowledgedMessages = bindLiveMessageToTurn(
        updateLiveMessageDeliveryStatus(liveMessagesRef.current, messageId, "sent"),
        messageId,
        response.runtime.activeTurnId
      );
      liveMessagesRef.current = acknowledgedMessages;
      setLiveMessages(acknowledgedMessages);
      syncRuntimeSnapshot(response.runtime);
      void pollCurrentSessionAfterInput(sessionId);
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) throw caught;
      const failedMessages = updateLiveMessageDeliveryStatus(liveMessagesRef.current, messageId, "failed");
      liveMessagesRef.current = failedMessages;
      setLiveMessages(failedMessages);
      const message = caught instanceof Error ? caught.message : "任务发送失败";
      const code = caught instanceof ApiRequestError ? caught.code : null;
      const activeWriter = code === "SESSION_ACTIVE_WRITER" || isActiveWriterMessage(message);
      setRuntimeError(activeWriter ? null : message);
      registerLiveTimelineEntry("error", `input-${messageId}`);
      const nextRetryContext = { messageId, turnId: null, text };
      setLiveErrors((current) => upsertById(current, {
        id: `input-${messageId}`,
        turnId: null,
        message,
        code: activeWriter ? "SESSION_ACTIVE_WRITER" : code,
        willRetry: false,
        createdAt: new Date().toISOString(),
        retryContext: nextRetryContext
      }));
      retryContextRef.current = nextRetryContext;
      setRetryContext(nextRetryContext);
      throw caught;
    }
  }

  async function handleBranchSession(mode: SessionBranchMode, requestedRetryContext?: RetryContext | null) {
    const sourceSessionId = selectedSession?.id ?? selectedSessionIdRef.current;
    if (!sourceSessionId || branchingMode) return;
    const branchRetryContext = requestedRetryContext ?? retryContextRef.current;

    setBranchingMode(mode);
    setRuntimeError(null);
    setSessionNotice(null);
    try {
      const response = await branchSession(sourceSessionId, mode);
      if (selectedSessionIdRef.current !== sourceSessionId) return;

      setSessions((current) => upsertSession(current, response.session));
      void loadSessions(search);
      const nextSessionId = response.session.id;
      const path = buildSessionDetailPath(nextSessionId);
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
      applySessionRoute({ kind: "detail", sessionId: nextSessionId });
      syncRuntimeSnapshot(response.runtime);

      const branchNotice = mode === "compact_new_topic"
        ? "已压缩上下文并创建新话题，原会话保持不变。"
        : "已创建 Fork 新会话，保留全部已保存历史。";
      if (!branchRetryContext) {
        setSessionNotice(branchNotice);
        return;
      }

      retryContextRef.current = branchRetryContext;
      setRetryContext(branchRetryContext);
      setSessionNotice(`${branchNotice} 正在自动重发上一条消息…`);
      try {
        await sendInputToSession(
          nextSessionId,
          branchRetryContext.text,
          response.runtime.permissionMode,
          { isRetry: true }
        );
        if (selectedSessionIdRef.current === nextSessionId) {
          retryContextRef.current = null;
          setRetryContext(null);
          setRetryDialogOpen(false);
          setSessionNotice(`${branchNotice} 已自动重发上一条消息。`);
        }
      } catch {
        if (selectedSessionIdRef.current === nextSessionId) {
          setSessionNotice(`${branchNotice} 已创建，但自动重发失败；原内容仍保留，可继续重试。`);
        }
      }
    } catch (caught) {
      if (selectedSessionIdRef.current === sourceSessionId) {
        const message = caught instanceof Error ? caught.message : "创建分支会话失败";
        const activeWriter = (caught instanceof ApiRequestError && caught.code === "SESSION_ACTIVE_WRITER")
          || isActiveWriterMessage(message);
        setRuntimeError(activeWriter ? null : message);
      }
    } finally {
      setBranchingMode(null);
    }
  }

  async function handleHistoryContinuation(requestedRetryContext?: RetryContext | null) {
    const sourceSession = selectedSession ?? sessionDetail;
    const sourceSessionId = sourceSession?.id ?? selectedSessionIdRef.current;
    const continuationContext = requestedRetryContext ?? retryContextRef.current;
    if (!sourceSession || !sourceSessionId || !continuationContext || historyContinuationPending) return;

    setHistoryContinuationPending(true);
    setRuntimeError(null);
    setSessionNotice(null);
    try {
      const response = await continueSessionFromHistory(sourceSessionId, {
        cwd: sourceSession.workspace,
        sourceTitle: sourceSession.title,
        text: continuationContext.text,
        permissionMode
      });
      if (selectedSessionIdRef.current !== sourceSessionId) return;

      setSessions((current) => upsertSession(current, response.session));
      void loadSessions(search);
      const nextSessionId = response.session.id;
      const path = buildSessionDetailPath(nextSessionId);
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
      applySessionRoute({ kind: "detail", sessionId: nextSessionId });
      syncRuntimeSnapshot(response.runtime);

      const titleNotice = response.metadataError
        ? "新会话已创建，但标题保存失败；会话仍可继续使用。"
        : "已创建“历史续聊（新会话）”，正在读取原会话历史并继续处理。";
      if (response.inputError) {
        retryContextRef.current = continuationContext;
        setRetryContext(continuationContext);
        setRuntimeError(response.inputError);
        setSessionNotice(`${titleNotice} 首次续聊请求失败，原输入仍保留，可重试。`);
      } else {
        retryContextRef.current = null;
        setRetryContext(null);
        setRetryDialogOpen(false);
        setSessionNotice(titleNotice);
      }
    } catch (caught) {
      if (selectedSessionIdRef.current === sourceSessionId) {
        setRuntimeError(caught instanceof Error ? caught.message : "创建历史续聊会话失败");
        retryContextRef.current = continuationContext;
        setRetryContext(continuationContext);
      }
    } finally {
      setHistoryContinuationPending(false);
    }
  }

  async function handlePermissionModeChange(nextMode: SessionPermissionMode) {
    if (!selectedSessionId) return;
    const status = runtime?.status ?? "history";
    setRuntimeError(null);

    if (!["history", "waiting_input", "exited", "failed"].includes(status)) {
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
      resolvedApprovalIdsRef.current.add(approval.id);
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      if (response.runtime) syncRuntimeSnapshot(response.runtime);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "审批处理失败";
      setRuntimeError(message);
      if (selectedSessionIdRef.current === approval.threadId) {
        void Promise.all([
          loadRuntime(approval.threadId, { silent: true }),
          loadSessionDetail(approval.threadId, { silent: true, includeTurns: historyLoadedSessionIdRef.current === approval.threadId })
        ]);
      }
      throw caught;
    }
  }

  async function handleRefresh() {
    await loadSessions(search);
    if (selectedSessionIdRef.current) {
      const sessionId = selectedSessionIdRef.current;
      await refreshCurrentSession(sessionId);
    }
  }

  async function handleLoadHistory() {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId || loadingHistory || historyLoadedSessionIdRef.current === sessionId) return;
    await loadSessionDetail(sessionId, { includeTurns: true });
  }

  function handleBackToList() {
    if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
    setRouteError(null);
    setDrawerOpen(false);
    setViewMode("list");
  }

  function handleOpenSettings() {
    if (user.role !== "owner") return;
    if (window.location.pathname !== "/settings") window.history.pushState(null, "", "/settings");
    applySessionRoute({ kind: "settings" });
  }

  function handleOpenMembers() {
    if (user.role !== "owner") return;
    if (window.location.pathname !== "/settings/members") window.history.pushState(null, "", "/settings/members");
    applySessionRoute({ kind: "members" });
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
        onSelect={handleSelectSession}
        onMetadataSaved={handleMetadataSaved}
        onCreateSession={user.role === "owner" ? handleCreateSession : undefined}
        creatingSessionWorkspace={creatingSessionWorkspace}
        createSessionError={createSessionError}
      />
    );
  }

  return (
    <Shell
      title="Codex Manage"
      leadingAction={viewMode === "list" ? (
        <button
          className="iconButton mobileOnly"
          type="button"
          aria-label="打开会话列表"
          title="会话列表"
          onClick={(event) => {
            drawerTriggerRef.current = event.currentTarget;
            setDrawerOpen(true);
          }}
        >
          <span aria-hidden="true">☰</span>
        </button>
      ) : undefined}
      reserveFloatingStatus={viewMode === "detail" && Boolean(selectedSession) && compactViewport}
      desktopWorkspace={viewMode === "list" || (viewMode === "detail" && !compactViewport)}
      action={(
        <div className="topbarActions">
          {user.role === "owner" ? (
            <button
              className="iconButton"
              type="button"
              aria-label="打开设置和诊断"
              title="设置和诊断"
              onClick={handleOpenSettings}
              disabled={viewMode === "settings" || viewMode === "members"}
            >
              <span aria-hidden="true">⚙</span>
            </button>
          ) : null}
          <button className="ghostButton" onClick={onLogout}>登出</button>
        </div>
      )}
    >
      {viewMode === "list" && user.role === "child" ? (
        <ChildAccessPage sessions={sessions} loading={loadingSessions} error={sessionError} onSelect={handleSelectSession} />
      ) : viewMode === "list" ? (
        <>
          <DesktopWorkspaceHome
            sessions={sessions}
            search={search}
            loadingSessions={loadingSessions}
            sessionError={sessionError}
            selectedSessionId={selectedSessionId}
            onSearchChange={setSearch}
            onSearchSubmit={handleSearchSubmit}
            onSelect={handleSelectSession}
            onMetadataSaved={handleMetadataSaved}
            onCreateSession={user.role === "owner" ? handleCreateSession : undefined}
            creatingSessionWorkspace={creatingSessionWorkspace}
            createSessionError={createSessionError}
          />

          <div className="mobileDashboardHome">
            <section className="mobileDashboardWelcome workspaceWelcome" aria-labelledby="mobile-workspace-welcome-title">
              <p className="workspaceWelcomeEyebrow">CODEX MANAGE</p>
              <h2 id="mobile-workspace-welcome-title">选择一个会话开始工作</h2>
              <p className="workspaceWelcomeDescription">从侧边栏浏览、搜索并继续本机 Codex 会话。打开后，任务进度与输入框会保留在此工作区。</p>

              {loadingSessions ? <div className="workspaceWelcomeLoading" role="status">正在准备你的工作台…</div> : null}
              {!loadingSessions && sessionError ? <div className="workspaceWelcomeHint">会话暂时无法加载，请点击刷新重试。</div> : null}
              {!loadingSessions && !sessionError && sessions.length === 0 ? (
                <div className="workspaceWelcomeHint">还没有可显示的会话。请先在 Codex CLI 中创建会话，再返回这里刷新。</div>
              ) : null}
              {!loadingSessions && !sessionError ? (
                <RecentSessions
                  sessions={sessions}
                  onSelect={handleSelectSession}
                  onOpenDrawer={(trigger) => {
                    drawerTriggerRef.current = trigger;
                    setDrawerOpen(true);
                  }}
                  onRefresh={() => loadSessions(search)}
                  refreshing={loadingSessions}
                />
              ) : null}
            </section>
          </div>
        </>
      ) : viewMode === "detail" ? (
        <ResizableWorkspaceLayout
          sidebar={(
            <>
            <div className="workspaceSidebarHeading">
              <strong>Codex</strong>
              <span>最近会话</span>
            </div>
            {renderSessionBrowser(false)}
            </>
          )}
          main={(
          <div className="workspaceConversation">
            <section className="toolbar detailToolbar">
              <div className="detailTitleBar">
                <button
                  className="iconButton mobileOnly"
                  type="button"
                  aria-label="打开会话列表"
                  title="会话列表"
                  onClick={(event) => {
                    drawerTriggerRef.current = event.currentTarget;
                    setDrawerOpen(true);
                  }}
                >
                  <span aria-hidden="true">☰</span>
                </button>
                <button className="iconButton backToListButton" aria-label="返回会话列表" title="返回会话列表" onClick={handleBackToList}>
                  <span aria-hidden="true">←</span>
                </button>
                <div className="detailTitleContent">
                  <p className="detailEyebrow">
                    <span className="desktopConversationLabel">当前会话</span>
                    <span className="mobileConversationProject">{selectedSession ? workspaceDisplayName(selectedSession.workspace) : "Codex Manage"}</span>
                  </p>
                  <h2 title={selectedSession?.title ?? selectedSessionId ?? "会话加载失败"}>
                    {selectedSession?.title ?? (loadingDetail ? "正在加载会话..." : "会话加载失败")}
                  </h2>
                </div>
              </div>
              <div className="toolbarActions">
                <button
                  className={compactViewport ? "iconButton detailMoreButton" : "ghostButton"}
                  type="button"
                  aria-label={compactViewport ? "切换模型" : undefined}
                  onClick={compactViewport ? handleOpenModelPicker : handleRefresh}
                  disabled={compactViewport
                    ? Boolean(modelSwitchDisabledReason(runtime?.status ?? "history")) || updatingModel
                    : loadingSessions || loadingDetail || loadingHistory}
                >
                  {compactViewport ? <span aria-hidden="true">⋯</span> : loadingSessions || loadingDetail || loadingHistory ? "刷新中" : "刷新"}
                </button>
              </div>
            </section>

            <section className="sessionDetail" aria-labelledby="session-detail-title">
              <h2 id="session-detail-title" className="srOnly">当前会话详情</h2>
              {selectedSession ? (
                <SessionDetailPanel
                  fallbackSession={selectedSession}
                  detail={sessionDetail}
                  loading={loadingDetail}
                  error={detailError}
                  historyLoaded={historyLoadedSessionId === selectedSession.id}
                  loadingHistory={loadingHistory}
                  historyError={historyError}
                  historyNotice={historyNotice}
                  runtime={runtime}
                  permissionMode={permissionMode}
                  runtimeError={runtimeError}
                  sessionNotice={sessionNotice}
                  pendingApprovals={pendingApprovals}
                  liveCommands={liveCommands}
                  liveMessages={liveMessages}
                  liveErrors={liveErrors}
                  liveTimeline={liveTimeline}
                  modelState={currentModelState}
                  updatingModel={updatingModel}
                  isChild={user.role === "child"}
                  onPermissionModeChange={handlePermissionModeChange}
                  onOpenModelPicker={(context) => {
                    if (context !== undefined) {
                      retryContextRef.current = context;
                      setRetryContext(context);
                    }
                    handleOpenModelPicker();
                  }}
                  onSendInput={handleSendInput}
                  onOpenRetry={(context) => {
                    retryContextRef.current = context;
                    setRetryContext(context);
                    setRetryDialogOpen(true);
                  }}
                  branchingMode={branchingMode}
                  onBranchSession={handleBranchSession}
                  historyContinuationPending={historyContinuationPending}
                  onContinueFromHistory={(context) => void handleHistoryContinuation(context)}
                  onLoadHistory={handleLoadHistory}
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
          </div>
          )}
        />
      ) : viewMode === "settings" ? (
      <SettingsPage
          config={currentConfig}
          health={health}
          loading={loadingDiagnostics}
          reloadingRuntime={reloadingRuntime}
          error={diagnosticsError}
          reloadNotice={runtimeReloadNotice}
          onBack={handleBackToList}
          onRefresh={loadDiagnostics}
          onReloadRuntime={handleReloadRuntime}
          onOpenMembers={handleOpenMembers}
        />
      ) : viewMode === "members" ? (
        <MembersPage user={user} onBack={handleOpenSettings} />
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

      {drawerOpen ? (
        <div className="drawerBackdrop" role="presentation" onClick={() => setDrawerOpen(false)}>
          <aside
            className="sessionDrawer"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="会话列表"
            onClick={(event) => event.stopPropagation()}
          >
            <MobileSessionDrawer
              isOwner={user.role === "owner"}
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              search={search}
              loading={loadingSessions}
              error={sessionError}
              closeButtonRef={drawerCloseRef}
              onClose={() => setDrawerOpen(false)}
              onOpenList={handleBackToList}
              onOpenSettings={handleOpenSettings}
              onSearchChange={setSearch}
              onSearchSubmit={handleSearchSubmit}
              onSelect={handleSelectSession}
              onMetadataSaved={handleMetadataSaved}
              onCreateSession={user.role === "owner" ? handleCreateSession : undefined}
              creatingSessionWorkspace={creatingSessionWorkspace}
              createSessionError={createSessionError}
            />
          </aside>
        </div>
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
          onApply={handleApplyModel}
        />
      ) : null}

      {viewMode === "detail" && retryDialogOpen && retryContext ? (
        <RetryLastMessageDialog
          message={retryContext.text}
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
const MAX_LIVE_COMMAND_OUTPUT_CHARS = 12000;

function useCompactViewport() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function keepFocusInside(event: globalThis.KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hasAttribute("hidden"));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function SettingsPage({
  config,
  health,
  loading,
  reloadingRuntime,
  error,
  reloadNotice,
  onBack,
  onRefresh,
  onReloadRuntime,
  onOpenMembers
}: {
  config: PublicConfig | null;
  health: HealthStatus | null;
  loading: boolean;
  reloadingRuntime: boolean;
  error: string | null;
  reloadNotice: string | null;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onReloadRuntime: () => Promise<void>;
  onOpenMembers: () => void;
}) {
  const appServer = health?.appServer ?? config?.appServer ?? null;
  const cliAvailable = health?.codexCli.available ?? Boolean(config?.codexCliVersion);
  const statusClass = health?.ok ? "healthy" : health ? "unhealthy" : "unknown";
  const statusText = loading && !health ? "检查中" : health?.ok ? "运行正常" : health ? "需要检查" : "状态未知";

  return (
    <div className="settingsPage">
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
          <button className="ghostButton" type="button" onClick={() => void onRefresh()} disabled={loading || reloadingRuntime}>
            {loading ? "检查中" : "重新检查"}
          </button>
          <button className="primaryButton" type="button" onClick={() => void onReloadRuntime()} disabled={loading || reloadingRuntime}>
            {reloadingRuntime ? "刷新中" : "刷新 Codex 运行时"}
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

      <section className="settingsSection" aria-labelledby="access-settings-title">
        <div className="settingsSectionHeader">
          <h3 id="access-settings-title">Access &amp; collaboration</h3>
          <span>主用户管理</span>
        </div>
        <div className="settingsRows">
          <div className="settingsRow settingsActionRow">
            <div>
              <span>Members &amp; access</span>
              <small>创建子用户，并为既有会话授予或撤销访问权限。</small>
            </div>
            <button className="ghostButton" type="button" onClick={onOpenMembers}>Open</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ChildAccessPage({
  sessions,
  loading,
  error,
  onSelect
}: {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <main className="childAccessPage" aria-labelledby="child-access-title">
      <section className="childAccessHero">
        <div className="childAccessIcon" aria-hidden="true">✓</div>
        <div>
          <p className="eyebrow">受限工作区</p>
          <h1 id="child-access-title">Authorized sessions</h1>
          <p>你只能访问主用户授权的会话。会话操作始终使用默认受控模式，并固定在原始 workspace。</p>
        </div>
      </section>

      {error ? <div className="errorBanner">{error}</div> : null}
      <section className="childAccessSection" aria-labelledby="authorized-sessions-title">
        <div className="childAccessSectionHeader">
          <div>
            <h2 id="authorized-sessions-title">Authorized sessions</h2>
            <span>{loading ? "载入中" : `${sessions.length} 个会话`}</span>
          </div>
          <span className="permissionBadge controlled">默认受控</span>
        </div>
        {loading ? <div className="emptyState">正在加载已授权会话...</div> : null}
        {!loading && sessions.length === 0 ? (
          <div className="childAccessEmpty">
            <strong>暂时没有已授权会话</strong>
            <span>请联系主用户为你授权一个既有会话。</span>
          </div>
        ) : null}
        {!loading && sessions.length > 0 ? (
          <div className="childSessionList">
            {sortSessionsByUpdatedAt(sessions).map((session) => (
              <button className="childSessionCard" type="button" key={session.id} onClick={() => onSelect(session)}>
                <span className={`workspaceRecentStatus ${session.status}`} aria-hidden="true" />
                <span className="childSessionCopy">
                  <strong>{session.title}</strong>
                  <small>{workspaceDisplayName(session.workspace)} · {formatDateTime(session.updatedAt)}</small>
                </span>
                <span className="childSessionArrow" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="childAccessNotice" aria-label="不可用功能">
        <h2>Unavailable actions</h2>
        <div>
          <span>创建新会话</span><strong>由 Codex CLI 创建</strong>
          <span>切换 workspace</span><strong>固定为授权会话 workspace</strong>
          <span>Settings &amp; diagnostics</span><strong>仅主用户可用</strong>
        </div>
      </section>
    </main>
  );
}

function MembersPage({ user, onBack }: { user: UserIdentity; onBack: () => void }) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGrantIds, setSelectedGrantIds] = useState<string[]>([]);
  const [savingGrants, setSavingGrants] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdCredential, setCreatedCredential] = useState<{ displayName: string; password: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const selected = collaborators.find((item) => item.id === selectedId) ?? null;

  async function loadMembers() {
    setLoading(true);
    setError(null);
    try {
      const [memberResponse, sessionResponse] = await Promise.all([getCollaborators(), getSessions()]);
      setCollaborators(memberResponse.collaborators);
      setSessions(sessionResponse.sessions);
      setSelectedId((current) => current && memberResponse.collaborators.some((item) => item.id === current)
        ? current
        : memberResponse.collaborators[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "成员信息加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMembers();
  }, []);

  useEffect(() => {
    setSelectedGrantIds(selected?.grants ?? []);
  }, [selectedId, selected?.grants]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const displayName = String(form.get("displayName") ?? "").trim();
    const localEmail = String(form.get("localEmail") ?? "").trim();
    const password = String(form.get("password") ?? "").trim();
    setCreating(true);
    setFormError(null);
    try {
      const response = await createCollaborator({ displayName, localEmail, password: password || undefined });
      setCollaborators((current) => [...current, response.collaborator]);
      setSelectedId(response.collaborator.id);
      setSelectedGrantIds([]);
      setCreatedCredential({ displayName: response.collaborator.displayName, password: response.initialPassword });
      setCreateOpen(false);
      event.currentTarget.reset();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "子用户创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function handleStatusChange(member: Collaborator) {
    setUpdatingStatus(member.id);
    setError(null);
    try {
      const response = await updateCollaboratorStatus(member.id, !member.active);
      setCollaborators((current) => current.map((item) => item.id === member.id ? response.collaborator : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "成员状态更新失败");
    } finally {
      setUpdatingStatus(null);
    }
  }

  async function handleSaveGrants() {
    if (!selected) return;
    setSavingGrants(true);
    setError(null);
    try {
      const response = await updateCollaboratorGrants(selected.id, selectedGrantIds);
      setCollaborators((current) => current.map((item) => item.id === selected.id ? response.collaborator : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "会话授权更新失败");
    } finally {
      setSavingGrants(false);
    }
  }

  function toggleGrant(sessionId: string) {
    setSelectedGrantIds((current) => current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId]);
  }

  return (
    <div className="membersPage">
      <section className="toolbar detailToolbar">
        <div className="detailTitleBar">
          <button className="iconButton" type="button" aria-label="返回设置" title="返回设置" onClick={onBack}>
            <span aria-hidden="true">←</span>
          </button>
          <div>
            <p className="detailEyebrow">Access &amp; collaboration</p>
            <h2>Members &amp; access</h2>
          </div>
        </div>
        <button className="primaryButton" type="button" onClick={() => { setFormError(null); setCreateOpen(true); }}>
          Add child user
        </button>
      </section>

      {error ? <div className="errorBanner">{error}</div> : null}
      {createdCredential ? (
        <section className="credentialNotice" role="status">
          <div>
            <strong>{createdCredential.displayName} 已创建</strong>
            <span>请安全地把 initial password 交给该用户；关闭此提示后不会再次显示。</span>
          </div>
          <code>{createdCredential.password}</code>
          <button className="ghostButton" type="button" onClick={() => void copyTextToClipboard(createdCredential.password)}>Copy</button>
          <button className="iconButton" type="button" aria-label="关闭初始密码提示" onClick={() => setCreatedCredential(null)}>×</button>
        </section>
      ) : null}

      <div className="membersLayout">
        <section className="membersListPanel" aria-labelledby="members-list-title">
          <div className="membersPanelHeader">
            <div><h3 id="members-list-title">Members</h3><span>{loading ? "载入中" : `${collaborators.length + 1} 个账号`}</span></div>
          </div>
          <button className="memberRow ownerMemberRow" type="button">
            <span className="memberAvatar">{user.displayName.slice(0, 2).toUpperCase()}</span>
            <span className="memberRowCopy"><strong>{user.displayName}</strong><small>{user.localEmail ?? "未设置邮箱"} · Owner</small></span>
            <span className="memberStatus active">Owner</span>
          </button>
          {collaborators.map((member) => (
            <button
              className={`memberRow${member.id === selectedId ? " selected" : ""}`}
              type="button"
              key={member.id}
              onClick={() => setSelectedId(member.id)}
            >
              <span className="memberAvatar">{member.displayName.slice(0, 2).toUpperCase()}</span>
              <span className="memberRowCopy"><strong>{member.displayName}</strong><small>{member.localEmail} · Child user</small></span>
              <span className={`memberStatus ${member.active ? "active" : "inactive"}`}>{member.active ? "Active" : "Disabled"}</span>
            </button>
          ))}
          {!loading && collaborators.length === 0 ? <div className="emptyState">还没有子用户。</div> : null}
        </section>

        <section className="memberDetailPanel" aria-labelledby="member-detail-title">
          {selected ? (
            <>
              <div className="memberDetailHeader">
                <div>
                  <p className="detailEyebrow">Child user</p>
                  <h3 id="member-detail-title">{selected.displayName}</h3>
                  <span>{selected.localEmail}</span>
                </div>
                <button className="ghostButton" type="button" onClick={() => void handleStatusChange(selected)} disabled={updatingStatus === selected.id}>
                  {updatingStatus === selected.id ? "Updating" : selected.active ? "Disable" : "Enable"}
                </button>
              </div>
              <div className="memberPolicyNotice"><strong>受控访问</strong><span>该用户不能访问 Settings、切换 workspace 或使用 full access。</span></div>
              <div className="grantHeader"><div><h4>Session access</h4><span>选择该用户可以打开的既有会话。</span></div><strong>{selectedGrantIds.length} selected</strong></div>
              <div className="grantList">
                {sessions.map((session) => (
                  <label className="grantRow" key={session.id}>
                    <input type="checkbox" checked={selectedGrantIds.includes(session.id)} onChange={() => toggleGrant(session.id)} />
                    <span><strong>{session.title}</strong><small>{workspaceDisplayName(session.workspace)} · {formatDateTime(session.updatedAt)}</small></span>
                  </label>
                ))}
                {sessions.length === 0 ? <div className="emptyState">当前没有可授权的既有 session。</div> : null}
              </div>
              <div className="memberDetailActions">
                <span>授权变更会立即影响下一次访问。</span>
                <button className="primaryButton" type="button" onClick={() => void handleSaveGrants()} disabled={savingGrants}>{savingGrants ? "Saving" : "Save access"}</button>
              </div>
            </>
          ) : (
            <div className="memberEmptyDetail"><strong>选择一个 child user</strong><span>管理其状态和 session access。</span></div>
          )}
        </section>
      </div>

      {createOpen ? (
        <div className="modalBackdrop" role="presentation" onClick={creating ? undefined : () => setCreateOpen(false)}>
          <section className="messageDialog collaboratorDialog" role="dialog" aria-modal="true" aria-labelledby="create-child-title" onClick={(event) => event.stopPropagation()}>
            <div className="dialogHeader"><div><h2 id="create-child-title">Add child user</h2><p className="muted">创建后可为该用户授权既有 session。</p></div><button className="iconButton" type="button" aria-label="关闭" onClick={() => setCreateOpen(false)}>×</button></div>
            <form className="dialogBody collaboratorForm" onSubmit={(event) => void handleCreate(event)}>
              <label>Display name<input name="displayName" required maxLength={80} placeholder="例如 Alex" /></label>
              <label>Local email<input name="localEmail" required type="email" maxLength={160} placeholder="alex@local" /></label>
              <label>Password <span className="muted">（留空自动生成）</span><input name="password" minLength={8} maxLength={200} type="password" autoComplete="new-password" placeholder="至少 8 位" /></label>
              {formError ? <div className="errorBanner">{formError}</div> : null}
              <div className="dialogActions"><button className="ghostButton" type="button" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</button><button className="primaryButton" type="submit" disabled={creating}>{creating ? "Creating" : "Create user"}</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SettingsRow({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="settingsRow">
      <span>{label}</span>
      <strong className={monospace ? "monospaceValue" : undefined} title={value}>{value}</strong>
    </div>
  );
}

function SessionDetailPanel({
  fallbackSession,
  detail,
  loading,
  error,
  historyLoaded,
  loadingHistory,
  historyError,
  historyNotice,
  runtime,
  permissionMode,
  runtimeError,
  sessionNotice,
  pendingApprovals,
  liveCommands,
  liveMessages,
  liveErrors,
  liveTimeline,
  modelState,
  updatingModel,
  isChild,
  branchingMode,
  historyContinuationPending,
  onPermissionModeChange,
  onOpenModelPicker,
  onSendInput,
  onOpenRetry,
  onBranchSession,
  onContinueFromHistory,
  onLoadHistory,
  onSubmitApproval
}: {
  fallbackSession: SessionSummary;
  detail: SessionDetail | null;
  loading: boolean;
  error: string | null;
  historyLoaded: boolean;
  loadingHistory: boolean;
  historyError: string | null;
  historyNotice: string | null;
  runtime: RuntimeSnapshot | null;
  permissionMode: SessionPermissionMode;
  runtimeError: string | null;
  sessionNotice: string | null;
  pendingApprovals: ApprovalSummary[];
  liveCommands: LiveCommand[];
  liveMessages: LiveMessage[];
  liveErrors: LiveErrorNotice[];
  liveTimeline: LiveTimelineEntry[];
  modelState: SessionModelState;
  updatingModel: boolean;
  isChild: boolean;
  branchingMode: SessionBranchMode | null;
  historyContinuationPending: boolean;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
  onOpenModelPicker: (retryContext?: RetryContext | null) => void;
  onSendInput: (text: string) => Promise<void>;
  onOpenRetry: (context: RetryContext) => void;
  onBranchSession: (mode: SessionBranchMode, retryContext?: RetryContext | null) => Promise<void>;
  onContinueFromHistory: (retryContext?: RetryContext | null) => void;
  onLoadHistory: () => Promise<void>;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  const session = detail ?? fallbackSession;
  const [expandedMessage, setExpandedMessage] = useState<{ title: string; text: string; meta?: string } | null>(null);
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const [visibleTurnCount, setVisibleTurnCount] = useState(DEFAULT_VISIBLE_TURNS);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineAtLatestRef = useRef(true);
  const initialScrollSessionRef = useRef<string | null>(null);
  const pendingHistoryLoadRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const [timelineScrollState, setTimelineScrollState] = useState({ canScrollUp: false, canScrollDown: false });
  const hasVisibleHistory = Boolean(detail?.turns.some((turn) => turn.items.some((item) => item.type !== "unknown" && item.type !== "file_change")));
  const visibleLiveTimeline = liveTimeline.filter((entry) => {
    if (entry.kind !== "command") return true;
    const command = liveCommands.find((item) => item.id === entry.id);
    const activeRuntime = runtime?.status === "starting" || runtime?.status === "running" || runtime?.status === "waiting_approval";
    return Boolean(activeRuntime && command && !isLiveCommandCompleted(command));
  });
  const pendingApprovalCount = Math.max(
    runtime?.pendingApprovalCount ?? 0,
    pendingApprovals.length,
    runtime?.status === "waiting_approval" ? 1 : 0
  );

  useEffect(() => {
    setVisibleTurnCount(DEFAULT_VISIBLE_TURNS);
    pendingHistoryLoadRef.current = null;
  }, [session.id]);

  useLayoutEffect(() => {
    const timelineScroll = timelineScrollRef.current;
    const previous = pendingHistoryLoadRef.current;
    if (!timelineScroll || !previous) return;

    timelineScroll.scrollTop = previous.scrollTop + (timelineScroll.scrollHeight - previous.scrollHeight);
    pendingHistoryLoadRef.current = null;
    updateTimelineScrollState();
  }, [visibleTurnCount]);

  useLayoutEffect(() => {
    const timelineScroll = timelineScrollRef.current;
    if (!timelineScroll || !historyLoaded || initialScrollSessionRef.current === session.id) return;

    timelineScroll.scrollTop = timelineScroll.scrollHeight;
    timelineAtLatestRef.current = true;
    initialScrollSessionRef.current = session.id;
    updateTimelineScrollState();
  }, [detail, historyLoaded, session.id]);

  async function copySessionId() {
    if (!await copyTextToClipboard(session.id)) return;
    setCopiedSessionId(true);
    window.setTimeout(() => setCopiedSessionId(false), 1500);
  }

  useEffect(() => {
    const timelineScroll = timelineScrollRef.current;
    if (!timelineScroll || !timelineAtLatestRef.current) return;
    timelineScroll.scrollTop = timelineScroll.scrollHeight;
    updateTimelineScrollState();
  }, [liveTimeline, liveMessages, liveCommands, liveErrors]);

  function updateTimelineScrollState() {
    const timelineScroll = timelineScrollRef.current;
    if (!timelineScroll) return;
    const maxScrollTop = Math.max(0, timelineScroll.scrollHeight - timelineScroll.clientHeight);
    setTimelineScrollState({
      canScrollUp: timelineScroll.scrollTop > 24,
      canScrollDown: timelineScroll.scrollTop < maxScrollTop - 24
    });
  }

  function handleTimelineScroll() {
    const timelineScroll = timelineScrollRef.current;
    if (!timelineScroll) return;
    timelineAtLatestRef.current = timelineScroll.scrollTop + timelineScroll.clientHeight >= timelineScroll.scrollHeight - 32;
    updateTimelineScrollState();
  }

  function scrollTimelineTo(position: "top" | "bottom") {
    const timelineScroll = timelineScrollRef.current;
    if (!timelineScroll) return;
    timelineAtLatestRef.current = position === "bottom";
    timelineScroll.scrollTo({
      top: position === "top" ? 0 : timelineScroll.scrollHeight,
      behavior: "smooth"
    });
  }

  async function handleSendInput(text: string) {
    await onSendInput(text);
  }

  return (
    <div className="detailStack">
      <div className="detailScrollContent">
        <div className="sessionHero sessionMetaStrip">
          <div className="sessionHeroContext">
            <span className="sessionMetaLabel">当前项目</span>
            <strong title={session.workspace}>{workspaceDisplayName(session.workspace)}</strong>
          </div>
          <div className="sessionHeroMeta" aria-label="会话元信息">
            <span className="sessionMetaValue">
              <span>更新时间</span>
              <time dateTime={session.updatedAt}>{formatDateTime(session.updatedAt)}</time>
            </span>
            <span className="sessionMetaValue sessionIdValue">
              <span>会话 ID</span>
              <code title={session.id}>{shortId(session.id)}</code>
              <button
                className="copySessionIdButton"
                type="button"
                title={copiedSessionId ? "已复制完整会话 ID" : "复制完整会话 ID"}
                aria-label={copiedSessionId ? "已复制完整会话 ID" : "复制完整会话 ID"}
                onClick={() => void copySessionId()}
              >
                <span aria-hidden="true">{copiedSessionId ? "✓" : "⧉"}</span>
              </button>
            </span>
          </div>
        </div>

        <div className="historyViewport">
          <div className="historyContent" ref={timelineScrollRef} onScroll={handleTimelineScroll}>
          {loading ? <div className="emptyState">正在加载详情...</div> : null}
          {error ? <div className="errorBanner">{error}</div> : null}
          {historyError ? <div className="errorBanner">{historyError}</div> : null}
          {detail && !historyLoaded ? (
            historyNotice ? (
              <div className="historyNotice" role="status">
                <strong>新会话</strong>
                <span>{historyNotice}</span>
              </div>
            ) : (
              <div className="emptyState">
                <p>{loadingHistory ? "正在加载最新历史消息..." : "历史消息暂未加载。"}</p>
                {!loadingHistory ? (
                  <button className="ghostButton" type="button" onClick={() => void onLoadHistory()}>
                    重新加载历史消息
                  </button>
                ) : null}
              </div>
            )
          ) : null}
          {historyLoaded && detail && !hasVisibleHistory && visibleLiveTimeline.length === 0 ? <div className="emptyState">暂无历史消息</div> : null}
          {historyLoaded && detail && hasVisibleHistory ? (
            <SessionTimeline
              detail={detail}
              visibleTurnCount={visibleTurnCount}
              onLoadMore={() => {
                const timelineScroll = timelineScrollRef.current;
                if (timelineScroll) {
                  pendingHistoryLoadRef.current = {
                    scrollTop: timelineScroll.scrollTop,
                    scrollHeight: timelineScroll.scrollHeight
                  };
                }
                setVisibleTurnCount((count) => count + DEFAULT_VISIBLE_TURNS);
              }}
              onOpenMessage={setExpandedMessage}
              liveMessages={liveMessages}
              liveCommands={liveCommands}
              liveErrors={liveErrors}
              liveTimeline={visibleLiveTimeline}
              onChooseModel={onOpenModelPicker}
              onRetry={onOpenRetry}
              branchingMode={branchingMode}
              onBranchSession={onBranchSession}
              historyContinuationPending={historyContinuationPending}
              onContinueFromHistory={onContinueFromHistory}
            />
          ) : visibleLiveTimeline.length > 0 ? (
            <SessionTimeline
              detail={{ turns: [] }}
              visibleTurnCount={0}
              onLoadMore={() => undefined}
              onOpenMessage={setExpandedMessage}
              liveMessages={liveMessages}
              liveCommands={liveCommands}
              liveErrors={liveErrors}
              liveTimeline={visibleLiveTimeline}
              onChooseModel={onOpenModelPicker}
              onRetry={onOpenRetry}
              branchingMode={branchingMode}
              onBranchSession={onBranchSession}
              historyContinuationPending={historyContinuationPending}
              onContinueFromHistory={onContinueFromHistory}
            />
          ) : null}
          </div>
          {timelineScrollState.canScrollUp || timelineScrollState.canScrollDown ? (
            <div className="timelineScrollControls" aria-label="会话内容快速定位">
              <button
                className="timelineScrollButton"
                type="button"
                aria-label="跳到会话顶部"
                title="跳到会话顶部"
                onClick={() => scrollTimelineTo("top")}
                disabled={!timelineScrollState.canScrollUp}
              >
                <span aria-hidden="true">↑</span>
              </button>
              <button
                className="timelineScrollButton"
                type="button"
                aria-label="跳到会话底部"
                title="跳到会话底部"
                onClick={() => scrollTimelineTo("bottom")}
                disabled={!timelineScrollState.canScrollDown}
              >
                <span aria-hidden="true">↓</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="composerDock">
        {sessionNotice ? <div className="successBanner composerWarning" role="status">{sessionNotice}</div> : null}
        {runtimeError ? <div className="errorBanner composerWarning" role="alert">{runtimeError}</div> : null}
        {runtime?.permissionMode === "full_access" && pendingApprovals.length > 0 ? (
          <div className="errorBanner composerWarning" role="alert">完全权限模式收到未预期的审批请求，系统未自动处理；你仍可拒绝或取消该请求。</div>
        ) : null}
        <ApprovalPanel
          approvals={pendingApprovals}
          pendingCount={pendingApprovalCount}
          onSubmitApproval={onSubmitApproval}
        />
        <TaskInput key={session.id} sessionId={session.id} runtime={runtime} onSend={handleSendInput} />
        <ComposerRuntimeBar
          runtime={runtime}
          modelState={modelState}
          permissionMode={permissionMode}
          pendingApprovalCount={pendingApprovalCount}
          isChild={isChild}
          updatingModel={updatingModel}
          onPermissionModeChange={onPermissionModeChange}
          onFocusApprovals={() => {
            const approvalPanel = document.getElementById("session-approval-panel");
            approvalPanel?.scrollIntoView({ behavior: "smooth", block: "center" });
            approvalPanel?.focus({ preventScroll: true });
          }}
          onOpenModelPicker={() => onOpenModelPicker()}
        />
      </div>
      {expandedMessage ? <MessageDetailDialog message={expandedMessage} onClose={() => setExpandedMessage(null)} /> : null}
    </div>
  );
}

function ComposerRuntimeBar({
  runtime,
  modelState,
  permissionMode,
  pendingApprovalCount,
  updatingModel,
  onPermissionModeChange,
  onFocusApprovals,
  onOpenModelPicker,
  isChild
}: {
  runtime: RuntimeSnapshot | null;
  modelState: SessionModelState;
  permissionMode: SessionPermissionMode;
  pendingApprovalCount: number;
  updatingModel: boolean;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
  onFocusApprovals: () => void;
  onOpenModelPicker: () => void;
  isChild: boolean;
}) {
  const status = runtime?.status ?? "history";
  const model = runtime?.model ?? modelState.actualModel ?? modelState.preferredModel;
  const effort = runtime?.reasoningEffort ?? modelState.actualReasoningEffort ?? modelState.preferredReasoningEffort;
  const modelDisabledReason = modelSwitchDisabledReason(status);
  const canChangePermission = status === "history" || status === "waiting_input" || status === "exited" || status === "failed";
  const [updatingPermission, setUpdatingPermission] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);

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
    await applyPermissionMode("full_access");
  }

  return (
    <>
      <section
        className={`composerRuntimeBar ${status}${pendingApprovalCount > 0 ? " hasApproval" : ""}`}
        aria-label="当前运行状态、模型与权限"
      >
        <div className="composerRuntimeState" title={runtimeStatusDescription(status, runtime?.activeTurnId)}>
          <span className="composerRuntimeDot" aria-hidden="true" />
          <span>状态</span>
          <strong>{runtimeStatusDescription(status, runtime?.activeTurnId)}</strong>
        </div>
        <div className="composerRuntimeModel" title={[model, effort].filter(Boolean).join(" · ") || "模型未识别"}>
          <span>模型</span>
          <strong>{model ?? "未识别"}</strong>
          {effort ? <small>{effort}</small> : null}
        </div>
        {pendingApprovalCount > 0 ? (
          <div className="composerRuntimeBadges">
            <span className="approvalCount">待审批 {pendingApprovalCount}</span>
          </div>
        ) : null}
        {isChild ? (
          <span className="permissionBadge controlled">受控模式 · 原始 workspace</span>
        ) : (
          <button
            className="ghostButton composerPermissionButton"
            type="button"
            onClick={handlePermissionToggle}
            disabled={!canChangePermission || updatingPermission}
            title={!canChangePermission ? "当前状态不可切换权限模式" : "切换权限模式"}
          >
            {updatingPermission ? "切换中" : permissionMode === "full_access" ? "完全权限" : "需审批"}
          </button>
        )}
        {pendingApprovalCount > 0 ? (
          <button
            className="ghostButton composerApprovalButton"
            type="button"
            onClick={onFocusApprovals}
            aria-label={`处理审批（${pendingApprovalCount}）`}
          >
            处理审批（{pendingApprovalCount}）
          </button>
        ) : null}
        <button
          className="ghostButton composerModelButton"
          type="button"
          onClick={onOpenModelPicker}
          disabled={Boolean(modelDisabledReason) || updatingModel}
          title={modelDisabledReason ?? "切换模型"}
        >
          {updatingModel ? "切换中" : <><span className="composerModelButtonLabel">模型选择</span><span className="composerModelButtonChevron" aria-hidden="true">›</span></>}
        </button>
      </section>
      {confirmFullAccess ? (
        <FullAccessConfirmDialog
          submitting={updatingPermission}
          onCancel={() => setConfirmFullAccess(false)}
          onConfirm={confirmPermissionMode}
        />
      ) : null}
    </>
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
            <div className="fullAccessWarningHeading">
              <span className="approvalAlertIcon" aria-hidden="true">!</span>
              <strong>该会话将跳过审批。</strong>
            </div>
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
  pendingCount,
  onSubmitApproval
}: {
  approvals: ApprovalSummary[];
  pendingCount: number;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  if (approvals.length === 0 && pendingCount === 0) return null;

  return (
    <section id="session-approval-panel" className="approvalPanel" aria-label="审批请求" tabIndex={-1}>
      <div className="panelHeaderCompact">
        <h3>待审批</h3>
        <span>{pendingCount}</span>
      </div>
      {approvals.length > 0 ? (
        <div className="approvalList">
          {approvals.map((approval) => (
            <ApprovalCard approval={approval} key={approval.id} onSubmitApproval={onSubmitApproval} />
          ))}
        </div>
      ) : (
        <div className="approvalLoadingState" role="status">正在加载审批请求，请稍候…</div>
      )}
    </section>
  );
}

function ApprovalCard({
  approval,
  onSubmitApproval,
  variant = "panel"
}: {
  approval: ApprovalSummary;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
  variant?: "panel" | "sheet";
}) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit(decision: ApprovalDecision): Promise<boolean> {
    setSubmitting(decision);
    setSubmitError(null);
    try {
      const answerPayload = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value.trim() ? [value.trim()] : []]));
      await onSubmitApproval(approval, decision, answerPayload);
      return true;
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "审批处理失败，请重试。");
      return false;
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <article className={`approvalCard ${variant === "sheet" ? "approvalCardSheet" : ""}`}>
      <div className="approvalHeader">
        <div>
          <strong>{variant === "sheet" ? "Review access" : approval.title}</strong>
          <p className="approvalDescription">{approval.reason ?? approvalExplanation(approval)}</p>
        </div>
        {variant === "panel" ? <span>{approvalKindLabel(approval.kind)}</span> : null}
      </div>
      <div className="approvalRiskRow">
        <span className={`approvalRiskBadge ${approvalRiskLevel(approval)}`}><i aria-hidden="true" />{approvalRiskLabel(approval)}</span>
        <span>{approvalRiskExplanation(approval)}</span>
      </div>
      {approval.command ? (
        <div className="approvalDetailField">
          <span>COMMAND</span>
          <pre className="commandText approvalCommandText" title="命令过长时可在此区域滚动查看完整内容">{approval.command}</pre>
        </div>
      ) : null}
      {approval.cwd ? (
        <div className="approvalDetailField approvalScopeField">
          <span>SCOPE</span>
          <div>
            <code>{approval.cwd}</code>
            <strong>{approvalScopeLabel(approval)}</strong>
          </div>
        </div>
      ) : null}
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
      {submitError ? <p className="errorText" role="alert">{submitError}</p> : null}
      <div className="approvalActions">
        <div className="approvalAllowActions">
          <button className="approvalAcceptButton" type="button" onClick={() => void submit("accept")} disabled={submitting !== null} aria-busy={submitting === "accept"}>
            {submitting === "accept" ? "Allowing" : "Allow once"}
          </button>
          <button className="approvalSessionButton" type="button" onClick={() => void submit("acceptForSession")} disabled={submitting !== null} aria-busy={submitting === "acceptForSession"}>
            {submitting === "acceptForSession" ? "Allowing" : "Allow for this session"}
          </button>
        </div>
        <div className="approvalDismissActions">
          <button className="approvalDeclineButton" type="button" onClick={() => void submit("decline")} disabled={submitting !== null} aria-busy={submitting === "decline"}>
            {submitting === "decline" ? "Denying" : "Deny request"}
          </button>
          <button className="ghostButton" type="button" onClick={() => void submit("cancel")} disabled={submitting !== null} aria-busy={submitting === "cancel"}>
            {submitting === "cancel" ? "Cancelling" : "Cancel"}
          </button>
        </div>
      </div>
      <p className="approvalSessionHint">Keeps this scope for the current session only</p>
      <p className="approvalPausedHint" role="status">Conversation paused until resolved</p>
    </article>
  );
}

function isReadOnlyApproval(approval: ApprovalSummary): boolean {
  if (approval.kind !== "command_execution" && approval.kind !== "legacy_exec") return false;
  const command = approval.command?.trim() ?? "";
  return /^(git\s+(diff|status|log|show)|rg\b|grep\b|cat\b|sed\b|ls\b|find\b|pwd\b|head\b|tail\b|which\b|npm\s+(test|run\s+(test|lint|typecheck)))/i.test(command);
}

function approvalRiskLevel(approval: ApprovalSummary): "readOnly" | "elevated" | "high" {
  if (approval.kind === "permissions") return "high";
  return isReadOnlyApproval(approval) ? "readOnly" : "elevated";
}

function approvalRiskLabel(approval: ApprovalSummary): string {
  const level = approvalRiskLevel(approval);
  return level === "readOnly" ? "READ-ONLY" : level === "high" ? "HIGH RISK" : "REQUIRES ACCESS";
}

function approvalRiskExplanation(approval: ApprovalSummary): string {
  const level = approvalRiskLevel(approval);
  return level === "readOnly"
    ? "No changes will be written"
    : level === "high"
      ? "Can change permissions or broaden access"
      : "Review the command before allowing it";
}

function approvalScopeLabel(approval: ApprovalSummary): string {
  return isReadOnlyApproval(approval) ? "read-only" : "command scope";
}

function approvalExplanation(approval: ApprovalSummary): string {
  return isReadOnlyApproval(approval)
    ? "This command only reads project files."
    : "This request needs access to the current project scope.";
}

function approvalKindLabel(kind: ApprovalSummary["kind"]): string {
  switch (kind) {
    case "file_change": return "文件变更";
    case "permissions": return "权限";
    case "tool_user_input": return "需要输入";
    case "legacy_apply_patch": return "应用改动";
    case "legacy_exec": return "执行命令";
    case "command_execution":
    default: return "命令";
  }
}

function LiveErrorCard({
  notice,
  onChooseModel,
  onRetry,
  historyContinuationPending,
  onContinueFromHistory
}: {
  notice: LiveErrorNotice;
  onChooseModel: (retryContext: RetryContext | null) => void;
  onRetry: (context: RetryContext) => void;
  historyContinuationPending: boolean;
  onContinueFromHistory: (retryContext?: RetryContext | null) => void;
}) {
  const activeWriter = notice.code === "SESSION_ACTIVE_WRITER";
  return (
    <article className={`liveErrorCard${notice.willRetry ? " retrying" : " terminal"}`} role={notice.willRetry ? "status" : "alert"}>
      <div>
        <strong>{activeWriter ? "会话暂时被占用" : notice.willRetry ? "模型请求正在重试" : "模型请求失败"}</strong>
        <span>{formatDateTime(notice.createdAt)}</span>
      </div>
      <p>{notice.message}</p>
      {activeWriter ? <p className="muted">切换会话或关闭窗口可能不会释放锁。请完全退出 ChatGPT（⌘Q）或重启 ChatGPT。</p> : null}
      {notice.code ? <code>{notice.code}</code> : null}
      {activeWriter ? (
        <div className="liveErrorActions">
          <button
            className="primaryButton"
            type="button"
            onClick={() => onContinueFromHistory(notice.retryContext)}
            disabled={historyContinuationPending || !notice.retryContext}
          >
            {historyContinuationPending ? "创建新会话中…" : "新建会话并读取历史后继续"}
          </button>
        </div>
      ) : !notice.willRetry ? (
        <div className="liveErrorActions">
          <button className="ghostButton" type="button" onClick={() => onChooseModel(notice.retryContext)}>选择其他模型</button>
          {notice.retryContext ? <button type="button" onClick={() => onRetry(notice.retryContext!)}>重试上一条消息</button> : null}
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

function TaskInput({ sessionId, runtime, onSend }: { sessionId: string; runtime: RuntimeSnapshot | null; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadedSessionAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const waitingApproval = runtime?.status === "waiting_approval";
  const waitingTurnId = runtime?.status === "running" && !runtime.activeTurnId;
  const disabled = submitting || uploading || waitingApproval || waitingTurnId || runtime?.status === "starting";

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => uploadSessionAttachment(sessionId, file)));
      setAttachments((current) => [...current, ...uploaded.map((item) => item.attachment)]);
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "附件上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextText = text.trim();
    if (!nextText || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const attachmentText = attachments.length
        ? `\n\n请读取以下附件作为本次输入上下文：\n${attachments.map((attachment) => `- ${attachment.path}`).join("\n")}`
        : "";
      await onSend(`${nextText}${attachmentText}`);
      setText("");
      setAttachments([]);
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
      <label className="taskInputPlus" title="上传附件" aria-label="上传附件">
        <span aria-hidden="true">+</span>
        <input className="srOnly" type="file" multiple onChange={(event) => void handleFiles(event)} disabled={disabled} />
      </label>
      {attachments.length > 0 ? (
        <div className="taskInputAttachments" aria-label="已添加附件">
          {attachments.map((attachment) => (
            <button key={attachment.path} type="button" className="taskAttachmentChip" title={attachment.path} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}>
              {attachment.name} ×
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={uploading ? "正在上传附件" : waitingApproval ? "请先处理审批" : waitingTurnId ? "正在同步任务状态" : "Message Codex"}
        disabled={disabled}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        rows={1}
      />
      {uploadError ? <span className="taskAttachmentError" role="alert">{uploadError}</span> : null}
      <button className="sendButton" type="submit" aria-label={submitting ? "发送中" : "发送消息"} title={submitting ? "发送中" : "发送消息"} disabled={disabled || text.trim().length === 0}>
        <svg className="sendIcon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.4 4.8 19.8 12 4.4 19.2l2.2-6.1 7.1-1.1-7.1-1.1-2.2-6.1Z" />
        </svg>
      </button>
    </form>
  );
}

function SessionTimeline({
  detail,
  visibleTurnCount,
  onLoadMore,
  onOpenMessage,
  liveMessages,
  liveCommands,
  liveErrors,
  liveTimeline,
  onChooseModel,
  onRetry,
  branchingMode,
  onBranchSession,
  historyContinuationPending,
  onContinueFromHistory
}: {
  detail: Pick<SessionDetail, "turns">;
  visibleTurnCount: number;
  onLoadMore: () => void;
  onOpenMessage: (message: { title: string; text: string; meta?: string }) => void;
  liveMessages: LiveMessage[];
  liveCommands: LiveCommand[];
  liveErrors: LiveErrorNotice[];
  liveTimeline: LiveTimelineEntry[];
  onChooseModel: (retryContext: RetryContext | null) => void;
  onRetry: (context: RetryContext) => void;
  branchingMode: SessionBranchMode | null;
  onBranchSession: (mode: SessionBranchMode, retryContext?: RetryContext | null) => Promise<void>;
  historyContinuationPending: boolean;
  onContinueFromHistory: (retryContext?: RetryContext | null) => void;
}) {
  const turns = detail.turns
    .map((turn) => ({ ...turn, items: turn.items.filter((item) => item.type !== "unknown" && item.type !== "file_change") }))
    .filter((turn) => turn.items.length > 0);
  const latestTurnCount = Math.min(DEFAULT_VISIBLE_TURNS, turns.length);
  const olderTurnsStart = Math.max(0, turns.length - visibleTurnCount);
  const latestTurnsStart = Math.max(0, turns.length - latestTurnCount);
  const loadedEarlierTurns = turns.slice(olderTurnsStart, latestTurnsStart);
  const latestTurns = turns.slice(latestTurnsStart);
  const hasMoreEarlierTurns = olderTurnsStart > 0;
  const historicalItemIds = new Set(turns.flatMap((turn) => turn.items.map((item) => item.id)));

  function renderTurn(turn: SessionDetail["turns"][number], absoluteIndex: number) {
    const finalAnswerExists = turn.items.some((item) => item.type === "agent_message" && isFinalAnswerPhase(item.phase));
    const commentaryItems = finalAnswerExists
      ? turn.items.filter((item) => item.type === "agent_message" && isCommentaryPhase(item.phase))
      : [];
    const visibleItems = finalAnswerExists
      ? turn.items.filter((item) => !(item.type === "agent_message" && isCommentaryPhase(item.phase)))
      : turn.items;

    const commentaryDetails = commentaryItems.length > 0 ? (
      <details className="commentaryDetails" key={`${turn.id}-commentary`}>
        <summary>查看 {commentaryItems.length} 条过程消息</summary>
        <div className="commentaryItems">
          {commentaryItems.map((item) => (
            <TurnItemView item={item} key={item.id} onOpenMessage={onOpenMessage} />
          ))}
        </div>
      </details>
    ) : null;

    return (
      <section className="turnBlock" key={turn.id}>
        <div className="turnHeader">
          <h3>Turn {absoluteIndex + 1}</h3>
          <span>{turn.status}</span>
          <span>{formatDateTime(turn.startedAt)}</span>
        </div>
        <div className="turnItems">
          {visibleItems.map((item) => (
            <Fragment key={item.id}>
              {item.type === "agent_message" && isFinalAnswerPhase(item.phase) ? commentaryDetails : null}
              <TurnItemView item={item} onOpenMessage={onOpenMessage} />
            </Fragment>
          ))}
        </div>
      </section>
    );
  }

  function renderLiveEntry(entry: LiveTimelineEntry) {
    if (entry.kind === "message") {
      const message = liveMessages.find((item) => item.id === entry.id);
      if (!message) return null;
      const visibleMessageText = message.role === "user" ? stripAmbientBrowserContext(message.text) : message.text;
      const alreadyInHistory = Boolean(message.itemId && historicalItemIds.has(message.itemId))
        || (message.role === "user" && Boolean(message.turnId) && turns.some((turn) => turn.id === message.turnId
          && turn.items.some((item) => item.type === "user_message" && stripAmbientBrowserContext(item.text) === visibleMessageText)));
      if (alreadyInHistory) return null;
      return (
        <article className={`messageItem ${message.role} liveMessage${message.deliveryStatus ? ` ${message.deliveryStatus}` : ""}`} key={`live-message-${message.id}`}>
          <div className="messageHeader">
            <strong>{message.role === "user" ? "用户" : "Codex"}</strong>
            <span className={message.deliveryStatus ? `deliveryStatus ${message.deliveryStatus}` : undefined}>
              {message.deliveryStatus ? deliveryStatusLabel(message.deliveryStatus) : null}
            </span>
          </div>
          <div className="messageBody"><MarkdownContent text={visibleMessageText || "..."} /></div>
        </article>
      );
    }

    if (entry.kind === "command") {
      const command = liveCommands.find((item) => item.id === entry.id);
      // Command output is only a live execution aid. Once it completes, it
      // belongs to the hidden command history and must not remain in the chat.
      if (!command || isLiveCommandCompleted(command)) return null;
      return <LiveCommandCard command={command} key={`live-command-${command.id}`} />;
    }

    const notice = liveErrors.find((item) => item.id === entry.id);
    return notice ? (
      <LiveErrorCard
        notice={notice}
        onChooseModel={onChooseModel}
        onRetry={onRetry}
        historyContinuationPending={historyContinuationPending}
        onContinueFromHistory={onContinueFromHistory}
        key={`live-error-${notice.id}`}
      />
    ) : null;
  }

  return (
    <div className="timeline" aria-label="会话消息">
      {hasMoreEarlierTurns ? (
        <button className="ghostButton loadMoreButton" type="button" onClick={onLoadMore}>
          加载更早 {Math.min(DEFAULT_VISIBLE_TURNS, olderTurnsStart)} 轮
        </button>
      ) : null}
      {loadedEarlierTurns.map((turn, index) => renderTurn(turn, olderTurnsStart + index))}
      {latestTurns.map((turn, index) => renderTurn(turn, latestTurnsStart + index))}
      {liveTimeline.map(renderLiveEntry)}
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
      return <MessageItem role="user" label="用户" text={stripAmbientBrowserContext(item.text)} onOpenMessage={onOpenMessage} />;
    case "agent_message":
      return <MessageItem role="agent" label="Codex" text={item.text} meta={item.phase ?? undefined} onOpenMessage={onOpenMessage} />;
    case "file_change":
      return null;
    case "context_compaction":
      return <SystemItem text="上下文已压缩" />;
    case "unknown":
    default:
      return null;
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

const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "codex-manage.workspace-sidebar-width.v1";
const DEFAULT_WORKSPACE_SIDEBAR_WIDTH = 280;
const MIN_WORKSPACE_SIDEBAR_WIDTH = 220;
const MAX_WORKSPACE_SIDEBAR_WIDTH = 520;

function clampWorkspaceSidebarWidth(width: number): number {
  return Math.min(MAX_WORKSPACE_SIDEBAR_WIDTH, Math.max(MIN_WORKSPACE_SIDEBAR_WIDTH, width));
}

function readWorkspaceSidebarWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_SIDEBAR_WIDTH;
  const stored = Number(window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) ? clampWorkspaceSidebarWidth(stored) : DEFAULT_WORKSPACE_SIDEBAR_WIDTH;
}

function ResizableWorkspaceLayout({
  sidebar,
  main,
  className = ""
}: {
  sidebar: ReactNode;
  main: ReactNode;
  className?: string;
}) {
  const layoutRef = useRef<HTMLElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readWorkspaceSidebarWidth());
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // A restricted browser storage must not prevent resizing the sidebar.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return;

    function handlePointerMove(event: globalThis.PointerEvent) {
      const layout = layoutRef.current;
      if (!layout) return;
      const nextWidth = event.clientX - layout.getBoundingClientRect().left;
      setSidebarWidth(clampWorkspaceSidebarWidth(nextWidth));
    }

    function stopResizing() {
      setResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    document.body.classList.add("workspaceSidebarResizing");

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      document.body.classList.remove("workspaceSidebarResizing");
    };
  }, [resizing]);

  function handleResizeStart(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    setResizing(true);
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -16 : 16;
      setSidebarWidth((current) => clampWorkspaceSidebarWidth(current + delta));
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSidebarWidth(event.key === "Home" ? MIN_WORKSPACE_SIDEBAR_WIDTH : MAX_WORKSPACE_SIDEBAR_WIDTH);
    }
  }

  const layoutStyle = { "--workspace-sidebar-width": `${sidebarWidth}px` } as CSSProperties;

  return (
    <section ref={layoutRef} className={`workspaceLayout${className ? ` ${className}` : ""}${resizing ? " resizing" : ""}`} style={layoutStyle}>
      <aside className="workspaceSidebar" aria-label="会话列表">
        {sidebar}
      </aside>
      <button
        className="workspaceSidebarResizeHandle"
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话列表宽度"
        title="拖动调整会话列表宽度，双击恢复默认"
        onPointerDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={() => setSidebarWidth(DEFAULT_WORKSPACE_SIDEBAR_WIDTH)}
      />
      {main}
    </section>
  );
}

function DesktopWorkspaceHome({
  sessions,
  search,
  loadingSessions,
  sessionError,
  selectedSessionId,
  onSearchChange,
  onSearchSubmit,
  onSelect,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace,
  createSessionError
}: {
  sessions: SessionSummary[];
  search: string;
  loadingSessions: boolean;
  sessionError: string | null;
  selectedSessionId: string | null;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
  createSessionError?: string | null;
}) {
  return (
    <ResizableWorkspaceLayout
      className="desktopWorkspaceHome"
      sidebar={(
        <>
          <div className="workspaceSidebarHeading">
            <strong>Codex</strong>
            <span>{sessions.length > 0 ? `最近会话 · ${sessions.length}` : "最近会话"}</span>
          </div>
          <SessionBrowser
            sessions={sessions}
            search={search}
            loadingSessions={loadingSessions}
            sessionError={sessionError}
            selectedSessionId={selectedSessionId}
            showHeading={false}
            onSearchChange={onSearchChange}
            onSearchSubmit={onSearchSubmit}
            onSelect={onSelect}
            onMetadataSaved={onMetadataSaved}
            onCreateSession={onCreateSession}
            creatingSessionWorkspace={creatingSessionWorkspace}
            createSessionError={createSessionError}
          />
        </>
      )}
      main={(
        <main className="workspaceConversation workspaceHomeMain">
        <section className="workspaceWelcome" aria-labelledby="workspace-welcome-title">
          <p className="workspaceWelcomeEyebrow">CODEX MANAGE</p>
          <h2 id="workspace-welcome-title">选择一个会话开始工作</h2>
          <p className="workspaceWelcomeDescription">从左侧浏览、搜索并继续本机 Codex 会话。打开后，任务进度与输入框会保留在此工作区。</p>

          {loadingSessions ? <div className="workspaceWelcomeLoading" role="status">正在准备你的工作台…</div> : null}
          {!loadingSessions && sessionError ? <div className="workspaceWelcomeHint">会话暂时无法加载，请在左侧重试。</div> : null}
          {!loadingSessions && !sessionError && sessions.length === 0 ? (
            <div className="workspaceWelcomeHint">还没有可显示的会话。请先在 Codex CLI 中创建会话，再返回这里刷新。</div>
          ) : null}
          {!loadingSessions && !sessionError ? <RecentSessions sessions={sessions} onSelect={onSelect} /> : null}
        </section>
        </main>
      )}
    />
  );
}

function RecentSessions({
  sessions,
  onSelect,
  onOpenDrawer,
  onRefresh,
  refreshing = false
}: {
  sessions: SessionSummary[];
  onSelect: (session: SessionSummary) => void;
  onOpenDrawer?: (trigger: HTMLButtonElement) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [recentExpanded, setRecentExpanded] = useState(false);
  const recentSessions = useMemo(() => sortSessionsByUpdatedAt(sessions).slice(0, 10), [sessions]);
  const visibleRecentSessions = recentExpanded ? recentSessions : recentSessions.slice(0, 5);

  useEffect(() => {
    if (recentSessions.length <= 5) setRecentExpanded(false);
  }, [recentSessions.length]);

  if (recentSessions.length === 0) return null;

  return (
    <section className="workspaceRecent" aria-label="最近会话">
      <div className="workspaceRecentHeading">
        <h3>最近使用</h3>
        <div className="workspaceRecentHeadingActions">
          {onOpenDrawer ? (
            <button
              className="workspaceRecentBrowse"
              type="button"
              onClick={(event) => onOpenDrawer(event.currentTarget)}
            >
              从侧边栏查看全部
            </button>
          ) : (
            <span>从侧边栏查看全部</span>
          )}
          {onRefresh ? (
            <button
              className="iconButton workspaceRecentRefresh"
              type="button"
              aria-label="刷新最近会话"
              title="刷新最近会话"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <span aria-hidden="true">↻</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className={`workspaceRecentList${recentExpanded ? " expanded" : ""}`}>
        {visibleRecentSessions.map((session) => (
          <button
            className="workspaceRecentSession"
            key={session.id}
            type="button"
            onClick={() => onSelect(session)}
            aria-label={`打开会话：${session.title}`}
          >
            <span className={`workspaceRecentStatus ${session.status}`} aria-hidden="true" />
            <span className="workspaceRecentCopy">
              <strong>{session.title}</strong>
              <small>{workspaceDisplayName(session.workspace)} · {formatDateTime(session.updatedAt)}</small>
            </span>
            {session.status !== "history" ? <span className="workspaceRecentMeta">{statusLabel(session.status)}</span> : null}
          </button>
        ))}
      </div>
      {recentSessions.length > 5 ? (
        <button className="workspaceRecentToggle" type="button" onClick={() => setRecentExpanded((current) => !current)}>
          {recentExpanded ? "收起" : `显示全部 ${recentSessions.length} 个`}
        </button>
      ) : null}
    </section>
  );
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
  onSelect,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace,
  createSessionError
}: {
  sessions: SessionSummary[];
  search: string;
  loadingSessions: boolean;
  sessionError: string | null;
  selectedSessionId: string | null;
  showHeading?: boolean;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
  createSessionError?: string | null;
}) {
  const workspaceFilterId = `session-workspace-filter-${showHeading ? "mobile" : "desktop"}`;
  const [mode, setMode] = useState<SessionListMode>("workspace");

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
          <button className="iconButton" type="submit" aria-label="搜索" title="搜索">
            <span aria-hidden="true">⌕</span>
          </button>
        </form>
      </div>

      <div className="sessionViewTabs" role="tablist" aria-label="会话列表视图">
        <button
          className={mode === "workspace" ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={mode === "workspace"}
          onClick={() => setMode("workspace")}
        >
          按项目目录
        </button>
        <button
          className={mode === "recent" ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={mode === "recent"}
          onClick={() => setMode("recent")}
        >
          最近 10 个
        </button>
      </div>

      {sessionError ? <div className="errorBanner">{sessionError}</div> : null}
      {createSessionError ? <div className="errorBanner">{createSessionError}</div> : null}
      {loadingSessions ? <div className="emptyState">正在加载会话...</div> : null}
      {!loadingSessions && sessions.length === 0 ? <div className="emptyState">没有匹配的会话</div> : null}
      {!loadingSessions && sessions.length > 0 ? (
        <SessionList
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          workspaceFilterId={workspaceFilterId}
          mode={mode}
          onSelect={onSelect}
          onMetadataSaved={onMetadataSaved}
          onCreateSession={onCreateSession}
          creatingSessionWorkspace={creatingSessionWorkspace}
        />
      ) : null}
    </>
  );
}

function MobileSessionDrawer({
  isOwner,
  sessions,
  selectedSessionId,
  search,
  loading,
  error,
  closeButtonRef,
  onClose,
  onOpenList,
  onOpenSettings,
  onSearchChange,
  onSearchSubmit,
  onSelect,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace,
  createSessionError
}: {
  isOwner: boolean;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  search: string;
  loading: boolean;
  error: string | null;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenList: () => void;
  onOpenSettings: () => void;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
  createSessionError?: string | null;
}) {
  return (
    <div className="mobileSessionDrawerContent">
      <header className="drawerHeader mobileDrawerHeader">
        <h2>Chats</h2>
        <div>
          {isOwner ? (
            <button
              className="drawerNewButton"
              type="button"
              aria-label="查看会话管理（不创建新会话）"
              title="新会话由 Codex CLI 创建"
              onClick={onOpenList}
            >
              <span aria-hidden="true">+</span> New
            </button>
          ) : null}
          <button ref={closeButtonRef} className="iconButton" type="button" aria-label="关闭会话列表" title="关闭" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <div className="mobileDrawerSessionBrowser">
        <SessionBrowser
          sessions={sessions}
          search={search}
          loadingSessions={loading}
          sessionError={error}
          selectedSessionId={selectedSessionId}
          showHeading={false}
          onSearchChange={onSearchChange}
          onSearchSubmit={onSearchSubmit}
          onSelect={onSelect}
          onMetadataSaved={onMetadataSaved}
          onCreateSession={onCreateSession}
          creatingSessionWorkspace={creatingSessionWorkspace}
          createSessionError={createSessionError}
        />
      </div>

      {isOwner ? (
        <footer className="drawerUtility">
          <button type="button" aria-label="打开设置和诊断" onClick={onOpenSettings}>
            <span aria-hidden="true">⚙</span>
            <span>Settings &amp; diagnostics</span>
            <strong>Healthy</strong>
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function workspaceDisplayName(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || workspace || "Codex Manage";
}

function isStandalonePwa(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayModeStandalone = typeof window.matchMedia === "function"
    && window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || displayModeStandalone;
}

function sessionUpdatedTimestamp(session: SessionSummary): number {
  const timestamp = Date.parse(session.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortSessionsByUpdatedAt(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => (
    sessionUpdatedTimestamp(right) - sessionUpdatedTimestamp(left)
    || left.title.localeCompare(right.title, "zh-Hans")
    || left.id.localeCompare(right.id)
  ));
}

function compareWorkspaceNames(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hans", { numeric: true, sensitivity: "base" })
    || workspaceDisplayName(left).localeCompare(workspaceDisplayName(right), "zh-Hans");
}

function sortSessionsByWorkspace(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => (
    compareWorkspaceNames(left.workspace.trim() || "未知工作目录", right.workspace.trim() || "未知工作目录")
    || sessionUpdatedTimestamp(right) - sessionUpdatedTimestamp(left)
    || left.title.localeCompare(right.title, "zh-Hans")
  ));
}

function SessionList({
  sessions,
  selectedSessionId,
  workspaceFilterId,
  mode,
  onSelect,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace
}: {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  workspaceFilterId: string;
  mode: SessionListMode;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
}) {
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [copiedWorkspace, setCopiedWorkspace] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const orderedSessions = useMemo(() => sortSessionsByWorkspace(sessions), [sessions]);
  const groups = useMemo(() => groupSessionsByWorkspace(orderedSessions), [orderedSessions]);
  const recentSessions = useMemo(() => sortSessionsByUpdatedAt(sessions).slice(0, 10), [sessions]);
  const activeWorkspace = groups.some((group) => group.workspace === selectedWorkspace)
    ? selectedWorkspace
    : groups[0]?.workspace ?? "";
  const activeGroup = groups.find((group) => group.workspace === activeWorkspace) ?? null;

  useEffect(() => {
    const selectedSession = selectedSessionId
      ? sessions.find((session) => isSameSession(session, selectedSessionId))
      : null;
    if (!selectedSession) return;
    const workspace = selectedSession.workspace.trim() || "未知工作目录";
    if (groups.some((group) => group.workspace === workspace)) setSelectedWorkspace(workspace);
  }, [groups, selectedSessionId, sessions]);

  async function copyWorkspacePath(workspace: string) {
    try {
      await navigator.clipboard.writeText(workspace);
    } catch {
      return;
    }
    setCopiedWorkspace(workspace);
    window.setTimeout(() => {
      setCopiedWorkspace((current) => (current === workspace ? null : current));
    }, 1500);
  }

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
      {mode === "workspace" && activeGroup ? (
        <div className="workspaceFilterRow">
          <label htmlFor={workspaceFilterId}>项目路径</label>
          <div className="workspaceSelectControl">
            <select
              id={workspaceFilterId}
              aria-label="按项目路径切换会话列表"
              value={activeWorkspace}
              onChange={(event) => setSelectedWorkspace(event.target.value)}
            >
              {groups.map((group) => (
                <option value={group.workspace} key={group.workspace}>
                  {group.workspace} · {group.sessions.length} 个会话
                </option>
              ))}
            </select>
            <button
              className="copyPathButton"
              type="button"
              title={copiedWorkspace === activeGroup.workspace ? "已复制" : "复制路径"}
              aria-label={`复制路径 ${activeGroup.workspace}`}
              onClick={() => copyWorkspacePath(activeGroup.workspace)}
            >
              <span aria-hidden="true">{copiedWorkspace === activeGroup.workspace ? "✓" : "⧉"}</span>
            </button>
            {onCreateSession ? (
              <button
                className="copyPathButton newSessionPathButton"
                type="button"
                title={creatingSessionWorkspace === activeGroup.workspace ? "正在创建会话" : "在此目录新增会话"}
                aria-label={`在 ${activeGroup.workspace} 新增会话`}
                onClick={() => void onCreateSession(activeGroup.workspace)}
                disabled={Boolean(creatingSessionWorkspace)}
              >
                <span aria-hidden="true">{creatingSessionWorkspace === activeGroup.workspace ? "…" : "+"}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {mode === "workspace" && activeGroup ? (() => {
        const expanded = expandedWorkspaces.has(activeGroup.workspace);
        const visibleSessions = expanded
          ? activeGroup.sessions
          : activeGroup.sessions.slice(0, DEFAULT_VISIBLE_GROUP_SESSIONS);
        const hiddenCount = activeGroup.sessions.length - visibleSessions.length;

        return (
          <section className="sessionWorkspaceGroup" aria-label={`${activeGroup.workspace} 的会话`}>
            <div className="workspaceGroupSummary">
              <p className="muted">
                {activeGroup.sessions.length} 个会话，默认显示最近 {Math.min(activeGroup.sessions.length, DEFAULT_VISIBLE_GROUP_SESSIONS)} 个
              </p>
            </div>
            <div className="workspaceGroupList">
              {visibleSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  selected={isSameSession(session, selectedSessionId)}
                  onSelect={onSelect}
                  onMetadataSaved={onMetadataSaved}
                />
              ))}
            </div>
            {activeGroup.sessions.length > DEFAULT_VISIBLE_GROUP_SESSIONS ? (
              <button className="ghostButton workspaceToggleButton" type="button" onClick={() => toggleWorkspace(activeGroup.workspace)}>
                {expanded ? "收起" : `展开更多 ${hiddenCount} 个会话`}
              </button>
            ) : null}
          </section>
        );
      })() : null}

      {mode === "recent" ? (
        <section className="sessionWorkspaceGroup recentSessionGroup" aria-label="最近修改的会话">
          <div className="workspaceGroupSummary">
            <p className="muted">最近修改的 {recentSessions.length} 个会话，按时间倒序排列</p>
          </div>
          <div className="workspaceGroupList recentSessionList">
            {recentSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                selected={isSameSession(session, selectedSessionId)}
                onSelect={onSelect}
                onMetadataSaved={onMetadataSaved}
              />
            ))}
          </div>
        </section>
      ) : null}
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

  return [...groups.entries()]
    .sort(([left], [right]) => compareWorkspaceNames(left, right))
    .map(([workspace, groupedSessions]) => ({
      workspace,
      sessions: sortSessionsByUpdatedAt(groupedSessions)
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
    <article
      className={`sessionItem${selected ? " selected" : ""}`}
    >
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
              <span title={session.title}>{session.title}</span>
              <small className="titleEditIcon" aria-hidden="true">{saving ? "…" : "✎"}</small>
            </button>
          )}
          {session.status !== "history" ? <StatusBadge status={session.status} /> : null}
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
  // Realtime/history payloads can be incomplete while an item is being
  // materialized. Rendering a missing body must not tear down the workspace.
  const normalizedText = text ?? "";
  const lines = normalizedText.replace(/\r\n/g, "\n").split("\n");
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
  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: normalizedText }];
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
  const pattern = /(!?\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
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
  const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (image) {
    const src = image[2];
    const safeSrc = /^https?:\/\//.test(src) || src.startsWith("/") || src.startsWith("data:image/") ? src : undefined;
    return safeSrc ? <img className="markdownImage" src={safeSrc} alt={image[1]} key={key} /> : <span key={key}>{image[1]}</span>;
  }

  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    const href = link[2];
    const safeHref = /^https?:\/\//.test(href) || href.startsWith("/") ? href : undefined;
    return safeHref ? (
      <a href={safeHref} key={key} target="_blank" rel="noreferrer" download={href.startsWith("/") ? true : undefined}>
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
  leadingAction,
  action,
  children,
  reserveFloatingStatus = false,
  desktopWorkspace = false
}: {
  title: string;
  leadingAction?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  reserveFloatingStatus?: boolean;
  desktopWorkspace?: boolean;
}) {
  return (
    <main className={`appShell${reserveFloatingStatus ? " reserveFloatingStatus" : ""}${desktopWorkspace ? " desktopWorkspaceShell" : ""}`}>
      <header className="topbar">
        <div className="topbarLeading">
          {leadingAction}
          <h1>{title}</h1>
        </div>
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

function isSameSession(
  session: Pick<SessionSummary, "id" | "sessionId"> | null | undefined,
  sessionId: string | null | undefined
): boolean {
  return Boolean(session && sessionId && (session.id === sessionId || session.sessionId === sessionId));
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

function isActiveWriterMessage(message: string): boolean {
  return /already has an active writer|active writer|writer lock|正在被其他 Codex 客户端写入|ChatGPT 正在占用此会话/i.test(message);
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

function upsertSession(sessions: SessionSummary[], session: SessionSummary): SessionSummary[] {
  const index = sessions.findIndex((current) => current.id === session.id);
  if (index === -1) return [session, ...sessions];
  const next = [...sessions];
  next[index] = session;
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

function bindLiveMessageToTurn(messages: LiveMessage[], messageId: string, turnId: string | null): LiveMessage[] {
  if (!turnId) return messages;
  return messages.map((message) => (message.id === messageId ? { ...message, turnId } : message));
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

function runtimeStatusDescription(status: SessionStatus, activeTurnId?: string | null): string {
  switch (status) {
    case "starting":
      return "启动中";
    case "running":
      return activeTurnId === undefined ? "运行中" : activeTurnId ? "运行中" : "运行中 · 正在同步";
    case "waiting_input":
      return "已完成 · 等待输入";
    case "waiting_approval":
      return "等待审批";
    case "exited":
      return "已退出";
    case "failed":
      return "执行失败";
    case "history":
    default:
      return "历史会话";
  }
}

function statusLabel(status: SessionStatus): string {
  return runtimeStatusDescription(status);
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

async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy copy path for non-secure local pages.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
