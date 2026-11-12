import { CSSProperties, ChangeEvent, ClipboardEvent, FormEvent, Fragment, KeyboardEvent, PointerEvent, ReactNode, RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, attachSessionToTask, branchSession, continueSessionFromHistory, createCollaborator, createSession, createTask, createTaskSession, getCollaborators, getHealthStatus, getLoginAccounts, getMe, getModels, getPublicConfig, getSessionDetail, getSessionRuntime, getSessionWebSocketUrl, getSessions, getTask, getTasks, login, logout, reloadRuntime, resumeSession, sendSessionInput, submitApproval, updateCollaboratorGrants, updateCollaboratorStatus, updateSessionMetadata, updateSessionModel, updateTask, uploadSessionAttachment, type UploadedSessionAttachment } from "../shared/api";
import type { ApprovalDecision, ApprovalSummary, Collaborator, HealthStatus, LoginAccount, ModelCatalogResponse, PublicConfig, RuntimeSnapshot, SessionBranchMode, SessionDetail, SessionModelState, SessionPermissionMode, SessionSummary, SessionStatus, SessionTurnItem, TaskDetail, TaskSummary, UpdateModelSelectionInput, UserIdentity, UserSession, WebSessionEvent } from "../shared/models";
import { ModelSelector } from "./ModelSelector";
import { BottomSheet } from "./BottomSheet";
import { useVisualViewport } from "./useVisualViewport";
import { UiIcon } from "./UiIcon";
import { modelStateAfterRuntimeSnapshot, modelSwitchDisabledReason } from "./modelSelection";
import { findRetryContextForTurn, findRetryContextFromFailedTurns, isCommentaryPhase, isFinalAnswerPhase, isTaskSendShortcut, isUnmaterializedThreadHistoryError, type RetryContext } from "./sessionInteractions";
import { buildSessionDetailPath, parseSessionRoute, type SessionRoute } from "./sessionRoute";
import { stripAmbientBrowserContext } from "../shared/messageText";
import { clearBootstrapSession, readBootstrapSession, writeBootstrapSession } from "./bootstrapSession";
import { mergeSessionHistory } from "./sessionHistory";
import { InteractionCard } from "./InteractionCard";

type LoadState = "loading" | "ready" | "error";
type WebSocketStatus = "idle" | "connecting" | "connected" | "disconnected";
type DashboardView = "list" | "settings" | "members" | "detail" | "invalid";
type SessionListMode = "workspace" | "task" | "recent";

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
  deliveryStatus: "sending" | "sent" | "failed" | "queued" | "unknown" | null;
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
  attachmentPaths?: string[];
  clientRequestId?: string;
};


export function App() {
  useVisualViewport();
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

        setLoadState("ready");
        if (me.authenticated && me.user?.role !== "child") {
          void getPublicConfig().then((value) => { if (!cancelled) setConfig(value); }).catch(() => undefined);
        }
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
    setLoadState("ready");
    if (nextSession.user?.role !== "child") void getPublicConfig().then(setConfig).catch(() => undefined);
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
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const sessionListModeRef = useRef<SessionListMode>("recent");
  const sessionListRequestRef = useRef<AbortController | null>(null);
  const tasksLoadedRef = useRef(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [creatingSessionWorkspace, setCreatingSessionWorkspace] = useState<string | null>(null);
  const [sessionDirectories, setSessionDirectories] = useState<string[] | null>(null);
  const [loadingSessionDirectories, setLoadingSessionDirectories] = useState(false);
  const [createSessionDirectory, setCreateSessionDirectory] = useState<string | null>(null);
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [createTaskDialogOpen, setCreateTaskDialogOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [createTaskSessionTask, setCreateTaskSessionTask] = useState<TaskSummary | null>(null);
  const [createTaskSessionHistory, setCreateTaskSessionHistory] = useState<SessionSummary[]>([]);
  const [loadingCreateTaskSession, setLoadingCreateTaskSession] = useState(false);
  const [sessionListMode, setSessionListMode] = useState<SessionListMode>("recent");
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
  const approvalsEventSeqRef = useRef(0);
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

  async function loadSessions(nextSearch = searchRef.current, appendCursor?: string) {
    sessionListRequestRef.current?.abort();
    const controller = new AbortController();
    sessionListRequestRef.current = controller;
    if (appendCursor) setLoadingMoreSessions(true);
    else setLoadingSessions(true);
    setSessionError(null);
    try {
      const paginated = sessionListModeRef.current === "recent" && !nextSearch.trim();
      const response = await getSessions(nextSearch, {
        paginated, ...(paginated ? { limit: 30, cursor: appendCursor } : {}), signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setSessions((current) => appendCursor
        ? [...new Map([...current, ...response.sessions].map((item) => [item.id, item])).values()]
        : response.sessions);
      setSessionCursor(response.nextCursor ?? null);
    } catch (caught) {
      if (!controller.signal.aborted) setSessionError(caught instanceof Error ? caught.message : "会话列表加载失败");
    } finally {
      if (!controller.signal.aborted) { setLoadingSessions(false); setLoadingMoreSessions(false); }
    }
  }

  function handleListModeChange(mode: SessionListMode) {
    if (mode === sessionListModeRef.current) return;
    sessionListModeRef.current = mode;
    setSessionListMode(mode);
    void loadSessions(searchRef.current);
    if (mode === "task" && user.role === "owner" && !tasksLoadedRef.current) void loadTasks();
  }

  async function loadTasks() {
    setLoadingTasks(true);
    try {
      const response = await getTasks();
      setTasks(response.tasks);
      tasksLoadedRef.current = true;
      setTaskError(null);
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "任务加载失败");
    } finally { setLoadingTasks(false); }
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
    let pending = false;
    async function pollRuntimeConfig() {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      try {
        const nextConfig = await getPublicConfig();
        if (active) setCurrentConfig(nextConfig);
      } catch {
        // 自动刷新检测是后台能力，诊断页保留显式错误展示。
      } finally { pending = false; }
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
    if (!selectedSessionId || viewMode !== "detail") return;
    const sessionId = selectedSessionId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function observe() {
      if (cancelled) return;
      const nextRuntime = await loadRuntime(sessionId, { silent: true });
      if (cancelled) return;
      if (document.visibilityState === "visible" && nextRuntime?.executionSource !== "manage") {
        await loadSessionDetail(sessionId, { silent: true, includeTurns: true });
      }
      if (cancelled) return;
      const pending = nextRuntime?.deliveries?.some(row => !["completed", "failed"].includes(row.status));
      timer = setTimeout(() => void observe(), pending ? 1000 : 5000);
    }
    timer = setTimeout(() => void observe(), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedSessionId, viewMode]);

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

  async function loadSessionDetail(sessionId: string, options: { silent?: boolean; includeTurns?: boolean; turnCursor?: string } = {}): Promise<SessionDetail | null> {
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
      const current = sessionDetailRef.current?.id === sessionId ? sessionDetailRef.current : null;
      const history = { turnLimit: 20, turnCursor: options.turnCursor, historyVersion: options.turnCursor ? undefined : current?.historyPage?.version ?? undefined };
      const requestKey = JSON.stringify([sessionId, includeTurns, history]);
      let request = sessionDetailRequestsRef.current.get(requestKey);
      if (!request) {
        request = getSessionDetail(sessionId, includeTurns, history);
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
      const latest = sessionDetailRef.current?.id === sessionId ? sessionDetailRef.current : null;
      const merged = includeTurns ? mergeSessionHistory(latest, response.session, Boolean(options.turnCursor))
        : { ...response.session, turns: latest?.turns ?? response.session.turns, ...(latest?.historyPage ? { historyPage: latest.historyPage } : {}) };
      sessionDetailRef.current = merged;
      setSessionDetail(merged);
      if (includeTurns) {
        historyLoadedSessionIdRef.current = sessionId;
        setHistoryLoadedSessionId(sessionId);
        setHistoryNotice(null);
        reconcileLiveMessagesWithHistory(merged);
      }
      return merged;
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
        || (message.role === "user" && historicalTurns.some(turn => turn.items.some(item => item.type === "user_message" && item.clientId === message.id)))
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
      if (response.approvals) syncApprovals(response.approvals, response.runtime.eventSeq);
      return response.runtime;
    } catch (caught) {
      if (selectedSessionIdRef.current !== sessionId) return null;
      if (!options.silent) setRuntimeError(caught instanceof Error ? caught.message : "运行状态加载失败");
      return null;
    }
  }

  function syncApprovals(approvals: ApprovalSummary[], seq: number) {
    if (seq < approvalsEventSeqRef.current) return;
    approvalsEventSeqRef.current = seq;
    setPendingApprovals(approvals.filter(isApprovalSummary).filter(approval => !resolvedApprovalIdsRef.current.has(approval.id)));
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
    if (runtime?.executionSource === "external_queue") { setModelActionError("此会话的模型、权限和审批请到桌面调整"); return; }
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
    if (selectedSessionId) await sendInputToSession(selectedSessionId, retryContext.text, permissionMode, {
      isRetry: true, clientRequestId: retryContext.clientRequestId, attachmentPaths: retryContext.attachmentPaths
    });
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
      if (event.seq < approvalsEventSeqRef.current) return;
      approvalsEventSeqRef.current = event.seq;
      const approval = payload.approval;
      if (resolvedApprovalIdsRef.current.has(approval.id)) return;
      setPendingApprovals((current) => upsertById(current, approval));
      return;
    }

    if (event.type === "approval_resolved" && isApprovalSummary(payload.approval)) {
      if (event.seq < approvalsEventSeqRef.current) return;
      approvalsEventSeqRef.current = event.seq;
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
    approvalsEventSeqRef.current = 0;
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

  function handleSelectTaskSession(session: SessionSummary) {
    sessionListModeRef.current = "task";
    setSessionListMode("task");
    handleSelectSession(session);
  }

  async function handleCreateSession(workspace: string) {
    if (user.role !== "owner" || creatingSessionWorkspace) return;
    setCreatingSessionWorkspace(workspace);
    setCreateSessionError(null);
    try {
      const response = await createSession(workspace);
      setSessions((current) => upsertSession(current, response.session));
      syncRuntimeSnapshot(response.runtime);
      await loadSessions("");
      setSessions((current) => upsertSession(current, response.session));
      const path = buildSessionDetailPath(response.threadId);
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
      applySessionRoute({ kind: "detail", sessionId: response.threadId });
      setCreateSessionDirectory(null);
    } catch (caught) {
      setCreateSessionError(caught instanceof Error ? caught.message : "新会话创建失败");
    } finally {
      setCreatingSessionWorkspace(null);
    }
  }

  async function handleCreateTask() {
    setTaskError(null);
    setCreateTaskDialogOpen(true);
  }

  async function handleSubmitCreateTask(name: string) {
    if (!name.trim() || creatingTask) return;
    setCreatingTask(true);
    try {
      const response = await createTask(name);
      setTasks((current) => [response.task, ...current]);
      setCreateTaskDialogOpen(false);
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "任务创建失败");
    } finally {
      setCreatingTask(false);
    }
  }

  async function handleToggleTask(task: TaskSummary) {
    try {
      const response = await updateTask(task.id, { pinned: !task.pinned });
      setTasks((current) => current.map((item) => item.id === task.id ? response.task : item));
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "任务更新失败");
    }
  }

  async function handleAttachSession(task: TaskSummary, selected: SessionSummary) {
    try {
      const response = await attachSessionToTask(task.id, selected.id);
      setTasks((current) => current.map((item) => item.id === task.id ? response.task : item));
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "会话归属任务失败");
      throw caught;
    }
  }

  async function handleCreateTaskSession(task: TaskSummary, workspace: string) {
    try {
      const response = await createTaskSession(task.id, workspace);
      setTasks((current) => current.map((item) => item.id === task.id ? response.task : item));
      setSessions((current) => upsertSession(current, response.session));
      handleSelectSession(response.session);
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "任务会话创建失败");
      throw caught;
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
        const payload = event.payload as Record<string, unknown>;
        if (isRuntimeSnapshot(payload.runtime)) syncRuntimeSnapshot(payload.runtime);
        if (Array.isArray(payload.approvals)) {
          syncApprovals(payload.approvals.filter(isApprovalSummary), event.seq);
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

  async function handleSendInput(text: string, attachmentPaths?: string[]) {
    if (!selectedSessionId) return;
    const previous = retryContextRef.current;
    const retryingDraft = previous?.turnId === null && previous.text === text
      && JSON.stringify(previous.attachmentPaths ?? []) === JSON.stringify(attachmentPaths ?? []);
    await sendInputToSession(selectedSessionId, text, permissionMode, {
      attachmentPaths, clientRequestId: retryingDraft ? previous?.clientRequestId : undefined
    });
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
    const messageId = options.clientRequestId ?? createLocalMessageId();
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
    liveMessagesRef.current = [...liveMessagesRef.current.filter(item => item.id !== messageId), localMessage];
    setLiveMessages((current) => [...current.filter(item => item.id !== messageId), localMessage]);
    try {
      const external = runtime?.threadId === sessionId && runtime.executionSource === "external_queue";
      const response = await sendSessionInput(sessionId, text, external ? undefined : nextPermissionMode, messageId, options.attachmentPaths, external);
      if (selectedSessionIdRef.current !== sessionId) return;
      const acknowledgedMessages = bindLiveMessageToTurn(
        updateLiveMessageDeliveryStatus(liveMessagesRef.current, messageId,
          response.runtime.executionSource === "external_queue"
            ? response.runtime.deliveries?.find(row => row.requestId === messageId)?.status === "unknown" ? "unknown" : "queued"
            : "sent"),
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
      const nextRetryContext = { messageId, turnId: null, text, clientRequestId: messageId, attachmentPaths: options.attachmentPaths };
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
    const sessionId = selectedSessionIdRef.current;
    await Promise.all([loadSessions(search), sessionId ? refreshCurrentSession(sessionId) : Promise.resolve()]);
  }

  async function handleLoadHistory() {
    const sessionId = selectedSessionIdRef.current;
    const cursor = sessionDetailRef.current?.historyPage?.nextCursor;
    if (!sessionId || loadingHistory || (historyLoadedSessionIdRef.current === sessionId && !cursor)) return;
    await loadSessionDetail(sessionId, { includeTurns: true, turnCursor: cursor ?? undefined });
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

  async function requestCreateSession(workspace: string) {
    setCreateSessionError(null);
    setCreateSessionDirectory(workspace);
    if (sessionCursor && !sessionDirectories && !loadingSessionDirectories) {
      setLoadingSessionDirectories(true);
      try { setSessionDirectories((await getSessions()).sessions.map((item) => item.workspace)); }
      catch (caught) { setCreateSessionError(caught instanceof Error ? caught.message : "工作目录加载失败"); }
      finally { setLoadingSessionDirectories(false); }
    }
  }

  function renderTaskPanel() {
    return (
      <TaskPanel
            tasks={tasks}
            loading={loadingTasks}
            sessions={sessions}
            error={taskError}
            onCreate={handleCreateTask}
            onTogglePin={handleToggleTask}
            onAttachSession={handleAttachSession}
            onCreateSession={async (task) => {
              setCreateTaskSessionHistory([]);
              setCreateTaskSessionTask(task);
              setLoadingCreateTaskSession(true);
              try {
                setCreateTaskSessionHistory((await getTask(task.id)).task.sessions);
              } catch (caught) {
                setTaskError(caught instanceof Error ? caught.message : "任务项目目录加载失败");
                setCreateTaskSessionTask(null);
              } finally {
                setLoadingCreateTaskSession(false);
              }
            }}
            onSelectSession={handleSelectTaskSession}
          />
    );
  }

  function renderSessionBrowser(showHeading = true) {
    return (
      <SessionBrowser
        sessions={sessions}
        tasks={tasks}
        search={search}
        loadingSessions={loadingSessions}
        hasMoreSessions={Boolean(sessionCursor)}
        loadingMoreSessions={loadingMoreSessions}
        onLoadMoreSessions={() => loadSessions(searchRef.current, sessionCursor ?? undefined)}
        sessionError={sessionError}
        selectedSessionId={selectedSessionId}
        showHeading={showHeading}
        taskPanel={user.role === "owner" ? renderTaskPanel() : undefined}
        onSearchChange={setSearch}
        onSearchSubmit={handleSearchSubmit}
        onSelect={handleSelectSession}
        mode={sessionListMode}
        onModeChange={handleListModeChange}
        onMetadataSaved={handleMetadataSaved}
        onCreateSession={user.role === "owner" ? requestCreateSession : undefined}
        creatingSessionWorkspace={creatingSessionWorkspace}
        createSessionError={createSessionError}
      />
    );
  }

  return (
    <Shell
      title="Codex Manage"
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
              <UiIcon name="settings" />
            </button>
          ) : null}
          <button className="iconButton logoutButton" aria-label="登出" title="登出" onClick={onLogout}><UiIcon name="logout" /><span>登出</span></button>
        </div>
      )}
    >
      {viewMode === "list" && user.role === "child" ? (
        <ChildAccessPage sessions={sessions} loading={loadingSessions} error={sessionError} onSelect={handleSelectSession} />
      ) : viewMode === "list" ? (
        <section className={`sessionLibrary ${compactViewport ? "mobileDashboardHome" : "desktopWorkspaceHome"}`} aria-label="会话管理">{renderSessionBrowser()}</section>
      ) : viewMode === "detail" ? (
        <ResizableWorkspaceLayout
          sidebar={(
            <>
            <div className="workspaceSidebarHeading">
              <strong>会话</strong>
              <button className="iconButton" type="button" aria-label="查看全部会话" onClick={handleBackToList}><UiIcon name="back" /><span>全部会话</span></button>
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
                  <UiIcon name="panel" />
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
              taskPanel={user.role === "owner" ? renderTaskPanel() : undefined}
              sessions={sessions}
              tasks={tasks}
              selectedSessionId={selectedSessionId}
              search={search}
              loading={loadingSessions}
              hasMoreSessions={Boolean(sessionCursor)}
              loadingMoreSessions={loadingMoreSessions}
              onLoadMoreSessions={() => loadSessions(searchRef.current, sessionCursor ?? undefined)}
              error={sessionError}
              closeButtonRef={drawerCloseRef}
              onClose={() => setDrawerOpen(false)}
              onOpenList={handleBackToList}
              onOpenSettings={handleOpenSettings}
              onSearchChange={setSearch}
              onSearchSubmit={handleSearchSubmit}
              onSelect={handleSelectSession}
              mode={sessionListMode}
              onModeChange={handleListModeChange}
              onMetadataSaved={handleMetadataSaved}
              onCreateSession={user.role === "owner" ? requestCreateSession : undefined}
              creatingSessionWorkspace={creatingSessionWorkspace}
              createSessionError={createSessionError}
            />
          </aside>
        </div>
      ) : null}

      {createSessionDirectory !== null ? (
        <CreateSessionDialog
          workspaces={[...new Set([...(sessionDirectories ?? []), ...sessions.map((item) => item.workspace)].filter((path) => path.trim()))]}
          loadingDirectories={loadingSessionDirectories}
          initialWorkspace={createSessionDirectory}
          submitting={Boolean(creatingSessionWorkspace)}
          error={createSessionError}
          onClose={() => setCreateSessionDirectory(null)}
          onSubmit={handleCreateSession}
        />
      ) : null}

      {createTaskDialogOpen ? (
        <CreateTaskDialog
          submitting={creatingTask}
          error={taskError}
          onCancel={() => { if (!creatingTask) setCreateTaskDialogOpen(false); }}
          onSubmit={handleSubmitCreateTask}
        />
      ) : null}

      {createTaskSessionTask ? (
        <CreateTaskSessionDialog
          task={createTaskSessionTask}
          history={createTaskSessionHistory}
          loading={loadingCreateTaskSession}
          onCancel={() => setCreateTaskSessionTask(null)}
          onSubmit={async (workspace) => {
            await handleCreateTaskSession(createTaskSessionTask, workspace);
            setCreateTaskSessionTask(null);
          }}
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
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px), (max-height: 500px) and (pointer: coarse)");
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
          <h3 id="access-settings-title">访问与协作</h3>
          <span>主用户管理</span>
        </div>
        <div className="settingsRows">
          <div className="settingsRow settingsActionRow">
            <div>
              <span>Members &amp; access</span>
              <small>创建子用户，并为既有会话授予或撤销访问权限。</small>
            </div>
            <button className="ghostButton" type="button" onClick={onOpenMembers}>管理成员</button>
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
  const [loadingGrants, setLoadingGrants] = useState(true);
  const grantRequestRef = useRef<AbortController | null>(null);
  const [grantSearch, setGrantSearch] = useState("");
  const [grantVisibleCount, setGrantVisibleCount] = useState(30);
  const filteredGrants = useMemo(() => {
    const term = grantSearch.trim().toLocaleLowerCase();
    return sessions.filter((item) => !term || `${item.title} ${item.workspace}`.toLocaleLowerCase().includes(term));
  }, [sessions, grantSearch]);
  useEffect(() => setGrantVisibleCount(30), [grantSearch]);
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
      const memberResponse = await getCollaborators();
      setCollaborators(memberResponse.collaborators);
      setSelectedId((current) => current && memberResponse.collaborators.some((item) => item.id === current)
        ? current
        : memberResponse.collaborators[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "成员信息加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadGrantSessions() {
    grantRequestRef.current?.abort();
    const controller = new AbortController();
    grantRequestRef.current = controller;
    setLoadingGrants(true);
    try {
      const response = await getSessions(undefined, { signal: controller.signal });
      if (!controller.signal.aborted) setSessions(response.sessions);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "会话加载失败");
    } finally { if (!controller.signal.aborted) setLoadingGrants(false); }
  }

  useEffect(() => {
    void loadMembers();
    void loadGrantSessions();
    return () => grantRequestRef.current?.abort();
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
            <p className="detailEyebrow">访问与协作</p>
            <h2>成员与访问权限</h2>
          </div>
        </div>
        <button className="primaryButton" type="button" onClick={() => { setFormError(null); setCreateOpen(true); }}>
          添加子用户
        </button>
      </section>

      {error ? <div className="errorBanner" role="alert">{error}<button className="ghostButton" type="button" onClick={() => { void loadMembers(); void loadGrantSessions(); }}>重新加载</button></div> : null}
      {createdCredential ? (
        <section className="credentialNotice" role="status">
          <div>
            <strong>{createdCredential.displayName} 已创建</strong>
            <span>请安全地把 初始密码 交给该用户；关闭此提示后不会再次显示。</span>
          </div>
          <code>{createdCredential.password}</code>
          <button className="ghostButton" type="button" onClick={() => void copyTextToClipboard(createdCredential.password)}>复制</button>
          <button className="iconButton" type="button" aria-label="关闭初始密码提示" onClick={() => setCreatedCredential(null)}>×</button>
        </section>
      ) : null}

      <div className="membersLayout">
        <section className="membersListPanel" aria-labelledby="members-list-title">
          <div className="membersPanelHeader">
            <div><h3 id="members-list-title">成员</h3><span>{loading ? "载入中" : `${collaborators.length + 1} 个账号`}</span></div>
          </div>
          <button className="memberRow ownerMemberRow" type="button">
            <span className="memberAvatar">{user.displayName.slice(0, 2).toUpperCase()}</span>
            <span className="memberRowCopy"><strong>{user.displayName}</strong><small>{user.localEmail ?? "未设置邮箱"} · 主用户</small></span>
            <span className="memberStatus active">主用户</span>
          </button>
          {collaborators.map((member) => (
            <button
              className={`memberRow${member.id === selectedId ? " selected" : ""}`}
              type="button"
              key={member.id}
              onClick={() => setSelectedId(member.id)}
            >
              <span className="memberAvatar">{member.displayName.slice(0, 2).toUpperCase()}</span>
              <span className="memberRowCopy"><strong>{member.displayName}</strong><small>{member.localEmail} · 子用户</small></span>
              <span className={`memberStatus ${member.active ? "active" : "inactive"}`}>{member.active ? "已启用" : "已停用"}</span>
            </button>
          ))}
          {!loading && collaborators.length === 0 ? <div className="emptyState">还没有子用户。</div> : null}
        </section>

        <section className="memberDetailPanel" aria-labelledby="member-detail-title">
          {selected ? (
            <>
              <div className="memberDetailHeader">
                <div>
                  <p className="detailEyebrow">子用户</p>
                  <h3 id="member-detail-title">{selected.displayName}</h3>
                  <span>{selected.localEmail}</span>
                </div>
                <button className="ghostButton" type="button" onClick={() => void handleStatusChange(selected)} disabled={updatingStatus === selected.id}>
                  {updatingStatus === selected.id ? "更新中" : selected.active ? "停用" : "启用"}
                </button>
              </div>
              <div className="memberPolicyNotice"><strong>受控访问</strong><span>该用户仅可访问已授权会话，不能修改系统设置、切换工作目录或使用完全访问权限。</span></div>
              <div className="grantHeader"><div><h4>会话授权</h4><span>选择该用户可以打开的既有会话。</span></div><strong>{selectedGrantIds.length} 个已选</strong></div>
              <input className="grantSearch" type="search" aria-label="搜索可授权会话" placeholder="搜索会话标题或工作目录…" value={grantSearch} onChange={(event) => setGrantSearch(event.target.value)} />
              {loadingGrants ? <p role="status">正在加载可授权会话…</p> : null}
              <div className="grantList">
                {filteredGrants.slice(0, grantVisibleCount).map((session) => (
                  <label className="grantRow" key={session.id}>
                    <input type="checkbox" checked={selectedGrantIds.includes(session.id)} onChange={() => toggleGrant(session.id)} />
                    <span><strong>{session.title}</strong><small>{workspaceDisplayName(session.workspace)} · {formatDateTime(session.updatedAt)}</small></span>
                  </label>
                ))}
                {!loadingGrants && filteredGrants.length === 0 ? <div className="emptyState">没有匹配的会话</div> : null}
                {filteredGrants.length > grantVisibleCount ? <button className="ghostButton sessionLoadMore" type="button" onClick={() => setGrantVisibleCount((count) => count + 30)}>显示更多会话（剩余 {filteredGrants.length - grantVisibleCount} 个）</button> : null}
              </div>
              <div className="memberDetailActions">
                <span>授权变更会立即影响下一次访问。</span>
                <button className="primaryButton" type="button" onClick={() => void handleSaveGrants()} disabled={savingGrants}>{savingGrants ? "保存中" : "保存授权"}</button>
              </div>
            </>
          ) : (
            <div className="memberEmptyDetail"><strong>选择一个子用户</strong><span>管理其状态和会话访问权限。</span></div>
          )}
        </section>
      </div>

      {createOpen ? (
        <div className="modalBackdrop" role="presentation" onClick={creating ? undefined : () => setCreateOpen(false)}>
          <section className="messageDialog collaboratorDialog" role="dialog" aria-modal="true" aria-labelledby="create-child-title" onClick={(event) => event.stopPropagation()}>
            <div className="dialogHeader"><div><h2 id="create-child-title">添加子用户</h2><p className="muted">创建后可为该用户授权既有会话。</p></div><button className="iconButton" type="button" aria-label="关闭" onClick={() => setCreateOpen(false)}>×</button></div>
            <form className="dialogBody collaboratorForm" onSubmit={(event) => void handleCreate(event)}>
              <label>显示名称<input name="displayName" required maxLength={80} placeholder="例如 Alex" /></label>
              <label>本地邮箱<input name="localEmail" required type="email" maxLength={160} placeholder="alex@local" /></label>
              <label>密码 <span className="muted">（留空自动生成）</span><input name="password" minLength={8} maxLength={200} type="password" autoComplete="new-password" placeholder="至少 8 位" /></label>
              {formError ? <div className="errorBanner">{formError}</div> : null}
              <div className="dialogActions"><button className="ghostButton" type="button" onClick={() => setCreateOpen(false)} disabled={creating}>取消</button><button className="primaryButton" type="submit" disabled={creating}>{creating ? "创建中" : "创建用户"}</button></div>
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
  onSendInput: (text: string, attachmentPaths?: string[]) => Promise<void>;
  onOpenRetry: (context: RetryContext) => void;
  onBranchSession: (mode: SessionBranchMode, retryContext?: RetryContext | null) => Promise<void>;
  onContinueFromHistory: (retryContext?: RetryContext | null) => void;
  onLoadHistory: () => Promise<void>;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  const session = detail ?? fallbackSession;
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const [visibleTurnCount, setVisibleTurnCount] = useState(DEFAULT_VISIBLE_TURNS);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineAtLatestRef = useRef(true);
  const initialScrollSessionRef = useRef<string | null>(null);
  const pendingHistoryLoadRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const [timelineScrollState, setTimelineScrollState] = useState({ canScrollUp: false, canScrollDown: false });
  const hasVisibleHistory = Boolean(detail?.turns.some((turn) => turn.items.some((item) => item.type !== "unknown" && item.type !== "file_change")));
  const desktopQueueErrorIds = new Set(runtime?.executionSource === "external_queue"
    ? liveErrors.filter((notice) => notice.code === "DESKTOP_QUEUE_TEXT_ONLY" || notice.code === "SESSION_ACTIVE_WRITER").map((notice) => notice.id)
    : []);
  const visibleRuntimeError = liveErrors.some((notice) => desktopQueueErrorIds.has(notice.id) && notice.message === runtimeError)
    ? null : runtimeError;
  const visibleLiveTimeline = liveTimeline.filter((entry) => {
    if (entry.kind === "error") return !desktopQueueErrorIds.has(entry.id);
    if (entry.kind !== "command") return true;
    const command = liveCommands.find((item) => item.id === entry.id);
    const activeRuntime = runtime?.status === "starting" || runtime?.status === "running" || runtime?.status === "waiting_approval" || runtime?.status === "waiting_user";
    return Boolean(activeRuntime && command && !isLiveCommandCompleted(command));
  });
  const pendingApprovalCount = Math.max(
    runtime?.pendingApprovalCount ?? 0,
    pendingApprovals.length,
    runtime?.status === "waiting_approval" || runtime?.status === "waiting_user" ? 1 : 0
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

  useEffect(() => {
    const element = timelineScrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (timelineAtLatestRef.current) element.scrollTop = element.scrollHeight;
      updateTimelineScrollState();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [session.id]);

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

  async function handleSendInput(text: string, attachmentPaths?: string[]) {
    await onSendInput(text, attachmentPaths);
  }

  return (
    <div className="detailStack">
      <div className="detailScrollContent">
        <div className="sessionHero sessionMetaStrip">
          <div className="sessionHeroContext">
            <span className="sessionMetaLabel">工作目录</span>
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
              loadingHistory={loadingHistory}
              onLoadMore={async (fromServer) => {
                const timelineScroll = timelineScrollRef.current;
                if (timelineScroll) {
                  pendingHistoryLoadRef.current = {
                    scrollTop: timelineScroll.scrollTop,
                    scrollHeight: timelineScroll.scrollHeight
                  };
                }
                if (fromServer) await onLoadHistory();
                setVisibleTurnCount((count) => count + DEFAULT_VISIBLE_TURNS);
              }}
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
                aria-label="回到最新"
                title="回到最新"
                onClick={() => scrollTimelineTo("bottom")}
                disabled={!timelineScrollState.canScrollDown}
              >
                <span aria-hidden="true">↓</span><span>回到最新</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="composerDock">
        {runtime?.executionSource === "external_queue" ? (
          <div className="successBanner composerWarning" role="status">
            此会话由桌面或其他客户端处理。后续文字沿用桌面设置并通过原生队列发送，审批、途中提问和界面选择、停止任务及设置请到桌面操作；Web 暂时无法读取或回答桌面的待交互请求。
            {runtime.deliveries?.filter(row => row.status !== "completed").map(row => (
              <div key={row.requestId}>{row.status === "unknown" || row.status === "submitting" ? "投递结果待确认，请勿重复发送" : row.status === "failed" ? "桌面处理失败" : row.status === "observed" ? "消息已进入原会话，等待桌面完成" : "已入队，等待桌面处理"}：{row.text.slice(0, 120)}{row.error ? `（${row.error}）` : ""}</div>
            ))}
          </div>
        ) : runtime?.leaseStatus === "releasing" ? <div className="composerWarning" role="status">正在释放占用，后续消息会按顺序处理。</div>
          : runtime?.leaseStatus === "released" ? <div className="composerWarning" role="status">已释放占用，可在桌面继续原会话。</div>
          : runtime?.leaseStatus === "blocked" ? <div className="composerWarning" role="status">暂未释放：{runtime.leaseReason}</div> : null}
        {sessionNotice ? <div className="successBanner composerWarning" role="status">{sessionNotice}</div> : null}
        {visibleRuntimeError && !(timelineAtLatestRef.current && liveErrors.some((notice) => notice.message === visibleRuntimeError && visibleLiveTimeline.some((entry) => entry.kind === "error" && entry.id === notice.id))) ? <div className="errorBanner composerWarning" role="alert">{visibleRuntimeError}</div> : null}
        {runtime?.permissionMode === "full_access" && pendingApprovals.some(approval => !["tool_user_input", "mcp_elicitation"].includes(approval.kind)) ? (
          <div className="errorBanner composerWarning" role="alert">完全权限模式收到未预期的审批请求，系统未自动处理；你仍可拒绝或取消该请求。</div>
        ) : null}
        <ApprovalPanel
          approvals={pendingApprovals}
          pendingCount={pendingApprovalCount}
          onSubmitApproval={onSubmitApproval}
        />
        <div className="composerStatus" role="status"><StatusBadge status={runtime?.status ?? "history"} /><span>{runtimeStatusDescription(runtime?.status ?? "history", runtime?.activeTurnId)}</span></div>
        <TaskInput key={session.id} sessionId={session.id} workspace={session.workspace} runtime={runtime} onSend={handleSendInput} controls={(
        <ComposerRuntimeBar
          runtime={runtime}
          modelState={modelState}
          permissionMode={permissionMode}
          isChild={isChild}
          updatingModel={updatingModel}
          onPermissionModeChange={onPermissionModeChange}
          onOpenModelPicker={() => onOpenModelPicker()}
        />
        )} />
      </div>
    </div>
  );
}

function ComposerRuntimeBar({
  runtime,
  modelState,
  permissionMode,
  updatingModel,
  onPermissionModeChange,
  onOpenModelPicker,
  isChild
}: {
  runtime: RuntimeSnapshot | null;
  modelState: SessionModelState;
  permissionMode: SessionPermissionMode;
  updatingModel: boolean;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
  onOpenModelPicker: () => void;
  isChild: boolean;
}) {
  const status = runtime?.status ?? "history";
  const model = runtime?.model ?? modelState.actualModel ?? modelState.preferredModel;
  const effort = runtime?.reasoningEffort ?? modelState.actualReasoningEffort ?? modelState.preferredReasoningEffort;
  const external = runtime?.executionSource === "external_queue";
  const modelDisabledReason = external ? "请到桌面调整模型" : modelSwitchDisabledReason(status);
  const canChangePermission = !external && (status === "history" || status === "waiting_input" || status === "exited" || status === "failed");
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
    await applyPermissionMode("full_access");
    setConfirmFullAccess(false);
  }

  return (
    <>
      <div className="composerRuntimeControls">
        <button className="ghostButton composerModelButton" type="button" onClick={onOpenModelPicker} disabled={Boolean(modelDisabledReason) || updatingModel} aria-label={`模型设置：${model ?? "跟随会话"}`} title={modelDisabledReason ?? [model ?? "跟随会话", effort].filter(Boolean).join(" · ")}>
          <span>{updatingModel ? "切换中" : model ?? "跟随会话"}</span><span aria-hidden="true">⌄</span>
        </button>
        {isChild ? <span className="permissionBadge controlled">受控模式</span> : (
          <button className={`ghostButton composerPermissionButton${permissionMode === "full_access" ? " fullAccess" : ""}`} type="button" onClick={handlePermissionToggle} disabled={!canChangePermission || updatingPermission} title={!canChangePermission ? "当前状态不可切换权限模式" : "切换权限模式"}>
            {external ? "权限由桌面管理" : updatingPermission ? "切换中" : permissionMode === "full_access" ? "完全权限" : "需审批"}
          </button>
        )}
      </div>
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

function FullAccessConfirmDialog({ submitting, onCancel, onConfirm }: { submitting: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <BottomSheet title="启用完全权限" description="当前会话" onClose={onCancel} busy={submitting} actions={(
      <><button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button><button className="dangerButton" type="button" onClick={() => void onConfirm().catch((caught) => setError(caught instanceof Error ? caught.message : "权限切换失败"))} disabled={submitting}>{submitting ? "启用中" : "确认启用"}</button></>
    )}>
      <div className="warning"><strong>该会话将跳过审批。</strong><p>Codex 将以 Web 服务账号获得完整文件系统和网络访问权限。</p></div>
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
    </BottomSheet>
  );
}

function RetryLastMessageDialog({ message, model, onCancel, onConfirm }: { message: string; model: string | null; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirmRetry() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try { await onConfirm(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "重试发送失败"); }
    finally { setSubmitting(false); }
  }
  return (
    <BottomSheet title="确认重试上一条消息" description="将创建新的回合，原失败记录会保留。" onClose={onCancel} busy={submitting} actions={(
      <><button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button><button type="button" onClick={() => void confirmRetry()} disabled={submitting}>{submitting ? "重试中" : "使用当前模型重试"}</button></>
    )}>
      <p className="retryModelSummary">本次使用模型 <strong>{model ?? "跟随会话"}</strong></p>
      <div className="retryMessagePreview"><MarkdownContent text={message} /></div>
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
    </BottomSheet>
  );
}

function ApprovalPanel({ approvals, pendingCount, onSubmitApproval }: { approvals: ApprovalSummary[]; pendingCount: number; onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const approval = approvals.find((item) => item.id === selectedId) ?? approvals[0];
  useEffect(() => { if (pendingCount === 0 && approvals.length === 0) setOpen(false); }, [pendingCount, approvals.length]);
  useEffect(() => { if (approval) setOpen(true); }, [approval?.id]);
  if (approvals.length === 0 && pendingCount === 0) return null;
  return (
    <section id="session-approval-panel" className="approvalPanel" aria-label="审批请求">
      <button className="approvalTrigger" type="button" onClick={() => setOpen(true)}><span aria-hidden="true">!</span><span><strong>有 {pendingCount} 项操作需要确认</strong><small>{approval?.title ?? "正在加载审批请求…"}</small></span><span aria-hidden="true">›</span></button>
      {open ? approval ? (
        <ApprovalCard key={approval.id} approval={approval} onClose={() => setOpen(false)} onSubmitApproval={onSubmitApproval} navigation={approvals.length > 1 ? (
          <label className="sheetField">待审批操作<select value={approval.id} onChange={(event) => setSelectedId(event.target.value)}>{approvals.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.title}</option>)}</select></label>
        ) : null} />
      ) : <BottomSheet title="待审批" onClose={() => setOpen(false)}><p role="status">正在加载审批请求，请稍候…</p></BottomSheet> : null}
    </section>
  );
}

function ApprovalCard({ approval, onSubmitApproval, onClose, navigation }: { approval: ApprovalSummary; onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>; onClose: () => void; navigation?: ReactNode }) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  if (approval.kind === "tool_user_input" || approval.kind === "mcp_elicitation") {
    return <InteractionCard approval={approval} onSubmit={onSubmitApproval} onClose={onClose} navigation={navigation} />;
  }
  async function submit(decision: ApprovalDecision) {
    if (submitting) return;
    setSubmitting(decision);
    setSubmitError(null);
    try {
      const payload = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value.trim() ? [value.trim()] : []]));
      await onSubmitApproval(approval, decision, payload);
    } catch (caught) { setSubmitError(caught instanceof Error ? caught.message : "审批处理失败，请重试。"); }
    finally { setSubmitting(null); }
  }
  return (
    <BottomSheet title={approval.title} description="关闭面板后仍会保持待审批。" onClose={onClose} busy={submitting !== null} className="approvalSheet" actions={(
      <div className="approvalActions">
        <button className="approvalAcceptButton" type="button" onClick={() => void submit("accept")} disabled={submitting !== null}>{submitting === "accept" ? "提交中…" : "仅允许这一次"}</button>
        <button className="ghostButton approvalSessionButton" type="button" onClick={() => void submit("acceptForSession")} disabled={submitting !== null}>{submitting === "acceptForSession" ? "提交中…" : "本会话内允许"}</button>
        <button className="ghostButton approvalDeclineButton" type="button" onClick={() => void submit("decline")} disabled={submitting !== null}>{submitting === "decline" ? "提交中…" : "拒绝此操作"}</button>
        <button className="ghostButton" type="button" onClick={() => void submit("cancel")} disabled={submitting !== null}>{submitting === "cancel" ? "提交中…" : "取消请求"}</button>
        <p>“本会话内允许”仅适用于当前会话内对应范围的审批。</p>
      </div>
    )}>
      {navigation}
      <div className="approvalRiskRow"><span className={`approvalRiskBadge ${approvalRiskLevel(approval)}`}>{approvalRiskLabel(approval)}</span><span>{approvalRiskExplanation(approval)}</span></div>
      <p>{approval.reason ?? approvalExplanation(approval)}</p>
      {approval.command ? <div className="approvalDetailField"><span>请求执行的命令</span><pre className="commandText approvalCommandText" tabIndex={0}>{approval.command}</pre></div> : null}
      {approval.cwd ? <div className="workspacePath"><span>Codex 服务所在机器上的工作目录</span><code>{approval.cwd}</code><small>{approvalScopeLabel(approval)}</small></div> : null}
      {approval.questions.map((question) => (
        <label className="sheetField" key={question.id}><span>{question.header}：{question.question}</span>
          {question.options?.length ? <select value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="">请选择</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}</select> : <input type={question.isSecret ? "password" : "text"} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
        </label>
      ))}
      {submitError ? <p className="errorText" role="alert">{submitError}</p> : null}
    </BottomSheet>
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
  return level === "readOnly" ? "读取或检查" : level === "high" ? "扩大访问权限" : "需要授权";
}

function approvalRiskExplanation(approval: ApprovalSummary): string {
  const level = approvalRiskLevel(approval);
  return level === "readOnly"
    ? "请核对实际命令及访问范围"
    : level === "high"
      ? "可能改变权限或扩大访问范围"
      : "允许前请核对操作内容";
}

function approvalScopeLabel(approval: ApprovalSummary): string {
  return `${approvalKindLabel(approval.kind)}的请求范围`;
}

function approvalExplanation(approval: ApprovalSummary): string {
  return isReadOnlyApproval(approval)
    ? "Codex 请求执行读取或检查操作，请核对实际命令。"
    : "此请求需要访问当前工作目录范围，请确认是否允许。";
}

function approvalKindLabel(kind: ApprovalSummary["kind"]): string {
  switch (kind) {
    case "file_change": return "文件变更";
    case "permissions": return "权限";
    case "tool_user_input": return "需要输入";
    case "mcp_elicitation": return "需要你确认或补充信息";
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

function TaskInput({ sessionId, workspace, runtime, onSend, controls }: { sessionId: string; workspace: string; runtime: RuntimeSnapshot | null; onSend: (text: string, attachmentPaths?: string[]) => Promise<void>; controls: ReactNode }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadedSessionAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const waitingApproval = runtime?.status === "waiting_approval" || runtime?.status === "waiting_user";
  const waitingTurnId = runtime?.status === "running" && !runtime.activeTurnId;
  const disabled = submitting || uploading || waitingApproval || waitingTurnId || runtime?.status === "starting";

  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "0px";
      input.style.height = `${Math.min(132, Math.max(48, input.scrollHeight))}px`;
    };
    resize();
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    let width = input.clientWidth;
    observer.observe(input);
    return () => observer.disconnect();
  }, [text]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || disabled) return;
    if (runtime?.executionSource === "external_queue") { setUploadError("桌面会话本期仅支持文字，附件请到桌面添加"); return; }
    setUploading(true);
    setUploadError(null);
    try {
      const results = await Promise.allSettled(files.map((file) => uploadSessionAttachment(sessionId, workspace, file)));
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value.attachment] : []);
      const failed = results.filter((result) => result.status === "rejected").length;
      setAttachments((current) => [...current, ...uploaded]);
      if (failed > 0) setUploadError(`${failed} 个附件上传失败，其余附件已保留`);
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "附件上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    await uploadFiles(files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void uploadFiles(imageFiles);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextText = text.trim();
    if (!nextText || disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSend(nextText, attachments.map(attachment => attachment.path));
      setText("");
      setAttachments([]);
      setUploadError(null);
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
      {attachments.length > 0 ? (
        <div className="taskInputAttachments" aria-label="已添加附件">
          {attachments.map((attachment) => (
            <button key={attachment.path} type="button" className="taskAttachmentChip" aria-label={`移除附件 ${attachment.name}`} disabled={submitting} title={attachment.path} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}>
              <span>{attachment.name}</span><span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        aria-label="发送给 Codex 的消息"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={uploading ? "正在上传附件" : waitingApproval ? runtime?.status === "waiting_user" ? "请先回答待处理问题" : "请先处理审批" : waitingTurnId ? "正在同步任务状态" : "继续提问，或描述新的想法…"}
        disabled={disabled}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        rows={1}
      />
      {uploadError ? <span className="taskAttachmentError" role="alert">{uploadError}</span> : null}
      {uploading ? <span className="taskAttachmentStatus" role="status">正在上传附件…</span> : null}
      <div className="taskInputTools">
        <input ref={fileInputRef} className="srOnly" type="file" accept="image/*,.pdf,.txt,.md,.json,.zip,.exe" multiple onChange={(event) => void handleFiles(event)} disabled={disabled} tabIndex={-1} />
        <button className="taskInputPlus" type="button" title="添加附件" aria-label="添加附件" onClick={() => fileInputRef.current?.click()} disabled={disabled}><span aria-hidden="true">＋</span></button>
        {controls}
      <button className="sendButton" type="submit" aria-label={submitting ? "发送中" : "发送消息"} title={submitting ? "发送中" : "发送消息"} disabled={disabled || text.trim().length === 0}>
        <svg className="sendIcon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.4 4.8 19.8 12 4.4 19.2l2.2-6.1 7.1-1.1-7.1-1.1-2.2-6.1Z" />
        </svg>
      </button>
      </div>
    </form>
  );
}

function SessionTimeline({
  detail,
  visibleTurnCount,
  onLoadMore,
  loadingHistory = false,
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
  detail: Pick<SessionDetail, "turns" | "historyPage">;
  visibleTurnCount: number;
  onLoadMore: (fromServer?: boolean) => void;
  loadingHistory?: boolean;
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
            <TurnItemView item={item} key={item.id} />
          ))}
        </div>
      </details>
    ) : null;

    return (
      <section className="turnBlock" key={turn.id}>
        <div className="turnHeader">
          <h3>Turn {absoluteIndex + 1}</h3>
          <span>{turn.status === "completed" ? "本轮已完成" : turn.status === "failed" ? "本轮失败" : turn.status === "interrupted" ? "本轮已中断" : turn.status === "inProgress" ? "进行中" : turn.status}</span>
          <span>{formatDateTime(turn.startedAt)}</span>
        </div>
        <div className="turnItems">
          {visibleItems.map((item) => (
            <Fragment key={item.id}>
              {item.type === "agent_message" && isFinalAnswerPhase(item.phase) ? commentaryDetails : null}
              <TurnItemView item={item} />
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
      {hasMoreEarlierTurns || detail.historyPage?.nextCursor ? (
        <button className="ghostButton loadMoreButton" type="button" disabled={loadingHistory} onClick={() => onLoadMore(!hasMoreEarlierTurns)}>
          {loadingHistory ? "正在加载更早消息…" : hasMoreEarlierTurns ? `加载更早 ${Math.min(DEFAULT_VISIBLE_TURNS, olderTurnsStart)} 轮` : "读取更早消息"}
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
}: {
  item: SessionTurnItem;
}) {
  switch (item.type) {
    case "user_message":
      return <MessageItem role="user" label="用户" text={stripAmbientBrowserContext(item.text)} />;
    case "agent_message":
      return <MessageItem role="agent" label="Codex" text={item.text} />;
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
}: {
  role: "user" | "agent";
  label: string;
  text: string;
}) {
  return (
    <article className={`messageItem ${role}`}>
      <div className="messageHeader">
        <strong>{label}</strong>
      </div>
      <div className="messageBody">
        <MarkdownContent text={text || "无内容"} />
      </div>
    </article>
  );
}

function CreateSessionDialog({ workspaces, loadingDirectories, initialWorkspace, submitting, error, onClose, onSubmit }: { loadingDirectories: boolean; workspaces: string[]; initialWorkspace: string; submitting: boolean; error: string | null; onClose: () => void; onSubmit: (workspace: string) => Promise<void> }) {
  const [workspace, setWorkspace] = useState(workspaces.includes(initialWorkspace) ? initialWorkspace : workspaces[0] ?? "");
  return (
    <BottomSheet title="选择工作目录" description="从已有会话的工作目录中选择，创建后再输入要求。" onClose={onClose} busy={submitting} actions={<button type="button" disabled={!workspace || submitting} onClick={() => void onSubmit(workspace)}>{submitting ? "创建中…" : "在此目录新建会话"}</button>}>
      {loadingDirectories ? <p className="muted" role="status">正在补充历史工作目录，已显示的目录可直接使用。</p> : null}
      <label className="sheetField">工作目录<select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>{workspaces.map((path) => <option key={path} value={path}>{workspaceDisplayName(path)}</option>)}</select></label>
      <div className="workspacePath"><span>Codex 服务所在机器上的路径（不是手机目录）</span><code>{workspace}</code></div>
      {error ? <p className="errorText" role="alert">{error}</p> : null}
    </BottomSheet>
  );
}

function CreateTaskDialog({ submitting, error, onCancel, onSubmit }: { submitting: boolean; error: string | null; onCancel: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const formId = "create-task-form";
  return (
    <BottomSheet title="新建任务" description="将相关会话归为一组，任务本身不会创建工作目录。" onClose={onCancel} busy={submitting} actions={(
      <><button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button><button type="submit" form={formId} disabled={submitting || !name.trim()}>{submitting ? "创建中…" : "创建任务"}</button></>
    )}>
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void onSubmit(name); }}><label className="sheetField">任务名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="例如：移动端体验优化" autoComplete="off" /></label></form>
      {error ? <p className="errorText" role="alert">{error}</p> : null}
    </BottomSheet>
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
  try {
    const stored = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!stored) return DEFAULT_WORKSPACE_SIDEBAR_WIDTH;
    const width = Number(stored);
    return Number.isFinite(width) ? clampWorkspaceSidebarWidth(width) : DEFAULT_WORKSPACE_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_WORKSPACE_SIDEBAR_WIDTH;
  }
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

function TaskPanel({
  tasks,
  loading,
  sessions,
  error,
  onCreate,
  onTogglePin,
  onAttachSession,
  onCreateSession,
  onSelectSession
}: {
  tasks: TaskSummary[];
  loading: boolean;
  sessions: SessionSummary[];
  error: string | null;
  onCreate: () => Promise<void>;
  onTogglePin: (task: TaskSummary) => Promise<void>;
  onAttachSession: (task: TaskSummary, session: SessionSummary) => Promise<void>;
  onCreateSession: (task: TaskSummary) => Promise<void>;
  onSelectSession: (session: SessionSummary) => void;
}) {
  const headingId = useId();
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [attachTask, setAttachTask] = useState<TaskSummary | null>(null);
  const [attachSessionId, setAttachSessionId] = useState("");
  const [openTask, setOpenTask] = useState<TaskSummary | null>(null);
  const [openTaskSessions, setOpenTaskSessions] = useState<SessionSummary[]>([]);
  const [loadingOpenTask, setLoadingOpenTask] = useState(false);
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  async function toggleTask(task: TaskSummary) {
    if (expandedTaskId === task.id) { setExpandedTaskId(null); return; }
    setExpandedTaskId(task.id);
    setTaskDetail(null);
    setLoadingTaskId(task.id);
    setActionError(null);
    try { setTaskDetail((await getTask(task.id)).task); }
    catch (caught) { setActionError(caught instanceof Error ? caught.message : "任务会话加载失败"); }
    finally { setLoadingTaskId(null); }
  }

  async function openTaskSession(task: TaskSummary, recent: SessionSummary | null) {
    if (task.sessionCount <= 1 && recent) {
      onSelectSession(recent);
      return;
    }
    setOpenTask(task);
    setOpenTaskSessions([]);
    setActionError(null);
    setLoadingOpenTask(true);
    try {
      setOpenTaskSessions((await getTask(task.id)).task.sessions);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "任务会话加载失败");
      setOpenTask(null);
    } finally {
      setLoadingOpenTask(false);
    }
  }
  return (
    <>
    <section className="taskPanel" aria-labelledby={headingId}>
      <div className="taskPanelHeader">
        <div><p className="workspaceWelcomeEyebrow">TASKS</p><h2 id={headingId}>任务</h2></div>
        <button className="primaryButton" type="button" onClick={() => void onCreate()}>新建任务</button>
      </div>
      {error || actionError ? <div className="errorBanner" role="alert">{error ?? actionError}</div> : null}
      {loading ? <p className="muted" role="status">正在加载任务…</p> : null}
      {!loading && tasks.length === 0 ? <p className="muted">创建任务后，可聚合多个相关会话并共享上下文。</p> : (
        <div className="taskGrid">
          {tasks.map((task) => {
            const recent = task.recentSessionId ? sessionMap.get(task.recentSessionId) : null;
            return <article className={`taskCard${task.pinned ? " pinned" : ""}`} key={task.id}>
              <div className="taskCardTitle"><button className="taskNameButton" type="button" onClick={() => void toggleTask(task)}><strong>{task.name}</strong></button><button className="iconButton" type="button" title={task.pinned ? "取消置顶" : "置顶任务"} aria-label={task.pinned ? "取消置顶" : "置顶任务"} onClick={() => void onTogglePin(task)}>{task.pinned ? "★" : "☆"}</button></div>
              <small>{task.sessionCount} 个会话{task.recentSessionTitle ? ` · 最近：${task.recentSessionTitle}` : ""}</small>
              {expandedTaskId === task.id ? <div className="taskSessionDetails">{loadingTaskId === task.id ? <span className="muted">正在加载任务会话…</span> : taskDetail?.sessions.map((session) => <button className="taskSessionLink" type="button" key={session.id} onClick={() => onSelectSession(session)}>{session.title}<small>{session.updatedAt}</small></button>)}</div> : null}
              <div className="taskCardActions">
                {task.recentSessionId ? <button className="taskRecentButton" type="button" onClick={() => void openTaskSession(task, recent ?? null)}><span>{task.sessionCount > 1 ? "选择会话打开" : "打开会话"}</span><small>{task.sessionCount > 1 ? `共 ${task.sessionCount} 个会话` : task.recentSessionTitle}</small></button> : null}
                <button className="ghostButton" type="button" onClick={() => { setAttachTask(task); setAttachSessionId(""); }} disabled={!sessions.length}>选择会话归入</button>
                <button className="ghostButton" type="button" onClick={() => void onCreateSession(task)}>新建任务会话</button>
              </div>
            </article>;
          })}
        </div>
      )}
    </section>
    {attachTask ? (
      <SessionAttachDialog
        task={attachTask}
        sessions={sessions}
        selectedSessionId={attachSessionId}
        onSelect={setAttachSessionId}
        onCancel={() => setAttachTask(null)}
        onSubmit={async () => {
          const selected = sessions.find((session) => session.id === attachSessionId);
          if (!selected) return;
          await onAttachSession(attachTask, selected);
          setAttachTask(null);
        }}
      />
    ) : null}
    {openTask ? (
      <SessionOpenDialog
        task={openTask}
        sessions={openTaskSessions}
        loading={loadingOpenTask}
        onCancel={() => setOpenTask(null)}
        onOpen={(session) => { setOpenTask(null); onSelectSession(session); }}
      />
    ) : null}
    </>
  );
}

function SessionAttachDialog({ task, sessions, selectedSessionId, onSelect, onCancel, onSubmit }: { task: TaskSummary; sessions: SessionSummary[]; selectedSessionId: string; onSelect: (sessionId: string) => void; onCancel: () => void; onSubmit: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = sessions.find((item) => item.id === selectedSessionId);
  return (
    <BottomSheet title="选择要归入的会话" description={task.name} onClose={onCancel} busy={submitting} actions={(
      <><button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button><button type="button" disabled={!selected || submitting} onClick={async () => { setSubmitting(true); setError(null); try { await onSubmit(); } catch (caught) { setError(caught instanceof Error ? caught.message : "归入失败"); } finally { setSubmitting(false); } }}>{submitting ? "归入中…" : "归入任务"}</button></>
    )}>
      <label className="sheetField">会话<select value={selectedSessionId} onChange={(event) => onSelect(event.target.value)}><option value="">请选择一个会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      {selected ? <div className="workspacePath"><span>工作目录</span><code>{selected.workspace}</code></div> : null}
      {error ? <p className="errorText" role="alert">{error}</p> : null}
    </BottomSheet>
  );
}

function SessionOpenDialog({ task, sessions, loading, onCancel, onOpen }: { task: TaskSummary; sessions: SessionSummary[]; loading: boolean; onCancel: () => void; onOpen: (session: SessionSummary) => void }) {
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const selected = sessions.find((item) => item.id === selectedSessionId);
  return (
    <BottomSheet title="选择要打开的会话" description={task.name} onClose={onCancel} actions={(
      <><button className="ghostButton" type="button" onClick={onCancel}>取消</button><button type="button" disabled={!selected} onClick={() => { if (selected) onOpen(selected); }}>打开会话</button></>
    )}>
      {loading ? <p role="status">正在加载任务会话…</p> : <label className="sheetField">会话<select value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}><option value="">请选择一个会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      {selected ? <div className="workspacePath"><span>工作目录</span><code>{selected.workspace}</code></div> : null}
    </BottomSheet>
  );
}

function CreateTaskSessionDialog({ task, history, loading, onCancel, onSubmit }: { task: TaskSummary; history: SessionSummary[]; loading: boolean; onCancel: () => void; onSubmit: (workspace: string) => Promise<void> }) {
  const workspaces = [...new Set(history.map((item) => item.workspace).filter(Boolean))];
  const recentWorkspace = history.find((item) => item.id === task.recentSessionId)?.workspace ?? workspaces[0] ?? "";
  const [mode, setMode] = useState("recent");
  const [newWorkspace, setNewWorkspace] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveMode = !recentWorkspace && mode === "recent" ? "new" : mode;
  const workspace = effectiveMode === "recent" ? recentWorkspace : effectiveMode === "new" ? newWorkspace : effectiveMode;
  const canSubmit = !loading && !submitting && workspace.trim().length > 0;
  return (
    <BottomSheet title="选择任务会话目录" description={task.name} onClose={onCancel} busy={submitting} actions={(
      <><button className="ghostButton" type="button" onClick={onCancel} disabled={submitting}>取消</button><button type="button" disabled={!canSubmit} onClick={async () => { setSubmitting(true); setError(null); try { await onSubmit(workspace.trim()); } catch (caught) { setError(caught instanceof Error ? caught.message : "创建失败"); } finally { setSubmitting(false); } }}>{submitting ? "创建中…" : "创建任务会话"}</button></>
    )}>
      <p className="muted">路径在 Codex 服务所在机器上，不是手机目录。</p>
      {loading ? <p role="status">正在加载任务历史…</p> : (
        <>
          <div className="taskDirectoryOptions">
            <label className={`taskDirectoryOption${effectiveMode === "recent" ? " selected" : ""}`}><input type="radio" name="task-directory-mode" checked={effectiveMode === "recent"} onChange={() => setMode("recent")} disabled={!recentWorkspace} /><span><strong>使用最近会话目录</strong><small>{recentWorkspace ? `${workspaceDisplayName(recentWorkspace)} · ${recentWorkspace}` : "暂无历史目录"}</small></span></label>
            {workspaces.filter((path) => path !== recentWorkspace).map((path) => <label className={`taskDirectoryOption${effectiveMode === path ? " selected" : ""}`} key={path}><input type="radio" name="task-directory-mode" checked={effectiveMode === path} onChange={() => setMode(path)} /><span><strong>使用历史会话目录 · {workspaceDisplayName(path)}</strong><small>{path}</small></span></label>)}
            <label className={`taskDirectoryOption${effectiveMode === "new" ? " selected" : ""}`}><input type="radio" name="task-directory-mode" checked={effectiveMode === "new"} onChange={() => setMode("new")} /><span><strong>输入新的工作目录</strong><small>仅任务新会话沿用“目录不存在时自动创建”</small></span></label>
          </div>
          {effectiveMode === "new" ? <label className="sheetField">Codex 服务所在机器上的路径<input value={newWorkspace} onChange={(event) => setNewWorkspace(event.target.value)} placeholder="例如：/workspace/my-project" /></label> : <div className="workspacePath"><span>将使用</span><code>{workspace}</code></div>}
        </>
      )}
      {error ? <p className="errorText" role="alert">{error}</p> : null}
    </BottomSheet>
  );
}

function SessionBrowser({
  taskPanel,
  sessions,
  tasks,
  search,
  loadingSessions,
  hasMoreSessions,
  loadingMoreSessions,
  onLoadMoreSessions,
  sessionError,
  selectedSessionId,
  showHeading = true,
  onSearchChange,
  onSearchSubmit,
  onSelect,
  mode,
  onModeChange,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace,
  createSessionError
}: {
  taskPanel?: ReactNode;
  sessions: SessionSummary[];
  tasks: TaskSummary[];
  search: string;
  loadingSessions: boolean;
  hasMoreSessions: boolean;
  loadingMoreSessions: boolean;
  onLoadMoreSessions: () => Promise<void>;
  sessionError: string | null;
  selectedSessionId: string | null;
  showHeading?: boolean;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (session: SessionSummary) => void;
  mode: SessionListMode;
  onModeChange: (mode: SessionListMode) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
  createSessionError?: string | null;
}) {
  const workspaceFilterId = useId();
  const [visibleCount, setVisibleCount] = useState(10);
  useEffect(() => setVisibleCount(10), [search, mode]);
  const hasMore = sessions.length > visibleCount || hasMoreSessions;
  async function showMore() {
    if (visibleCount >= sessions.length && hasMoreSessions) await onLoadMoreSessions();
    setVisibleCount((count) => count + 10);
  }
  const createButton = onCreateSession && mode !== "task" ? (
    <button className="primaryButton newSessionButton" type="button" aria-label="新建会话" onClick={() => void onCreateSession("")} disabled={Boolean(creatingSessionWorkspace) || !sessions.some((item) => item.workspace.trim())}><UiIcon name="plus" /><span>新建会话</span></button>
  ) : null;

  return (
    <>
      {showHeading ? (
        <div className="sessionLibraryHeading">
          <div>
            <h2>会话</h2>
            <p className="muted">{loadingSessions && sessions.length === 0 ? "正在载入会话…" : hasMoreSessions ? `已载入 ${sessions.length} 个会话 · 更多记录按需加载` : `共 ${sessions.length} 个会话`}</p>
          </div>
          {createButton}
        </div>
      ) : null}
      <div className={`sessionBrowserControls${showHeading ? "" : " compact"}`}>
        <form className="searchForm" onSubmit={onSearchSubmit}>
          <UiIcon name="search" />
          <input
            aria-label="搜索会话"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索会话…"
          />
          <button className="iconButton" type="submit" aria-label="搜索" title="搜索">
            <span aria-hidden="true">↵</span>
          </button>
        </form>
        <div className="sessionViewTabs" role="tablist" aria-label="会话列表视图">
        {([["recent", "最近会话"], ["workspace", "按工作目录"], ["task", "按任务"]] as const).map(([value, label]) => (
          <button key={value} className={mode === value ? "active" : ""} type="button" role="tab" aria-selected={mode === value} onClick={() => onModeChange(value)}>{label}</button>
        ))}
        </div>
      </div>
      {mode === "task" ? taskPanel : null}
      {!showHeading ? createButton : null}

      {sessionError ? <div className="errorBanner">{sessionError}</div> : null}
      {createSessionError ? <div className="errorBanner">{createSessionError}</div> : null}
      {loadingSessions && sessions.length === 0 ? <div className="sessionSkeleton" role="status" aria-label="正在加载会话"><span /><span /><span /></div> : null}
      {loadingSessions && sessions.length > 0 ? <p className="listLoadingStatus" role="status">正在更新会话…</p> : null}
      {!loadingSessions && sessions.length === 0 ? <div className="emptyState">没有匹配的会话</div> : null}
      {sessions.length > 0 ? (
        <SessionList
          sessions={sessions}
          visibleCount={visibleCount}
          selectedSessionId={selectedSessionId}
          workspaceFilterId={workspaceFilterId}
          mode={mode}
          tasks={tasks}
          onSelect={onSelect}
          onMetadataSaved={onMetadataSaved}
          onCreateSession={onCreateSession}
          creatingSessionWorkspace={creatingSessionWorkspace}
        />
      ) : null}
      {mode === "recent" && hasMore ? <button className="ghostButton sessionLoadMore" type="button" disabled={loadingMoreSessions || loadingSessions} onClick={() => void showMore()}>{loadingMoreSessions ? "正在加载…" : "显示更多会话"}</button> : null}
    </>
  );
}

function MobileSessionDrawer({
  isOwner,
  taskPanel,
  sessions,
  tasks,
  selectedSessionId,
  search,
  loading,
  hasMoreSessions,
  loadingMoreSessions,
  onLoadMoreSessions,
  error,
  closeButtonRef,
  onClose,
  onOpenList,
  onOpenSettings,
  onSearchChange,
  onSearchSubmit,
  onSelect,
  mode,
  onModeChange,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace,
  createSessionError
}: {
  isOwner: boolean;
  taskPanel?: ReactNode;
  sessions: SessionSummary[];
  tasks: TaskSummary[];
  selectedSessionId: string | null;
  search: string;
  loading: boolean;
  hasMoreSessions: boolean;
  loadingMoreSessions: boolean;
  onLoadMoreSessions: () => Promise<void>;
  error: string | null;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenList: () => void;
  onOpenSettings: () => void;
  onSearchChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (session: SessionSummary) => void;
  mode: SessionListMode;
  onModeChange: (mode: SessionListMode) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
  createSessionError?: string | null;
}) {
  return (
    <div className="mobileSessionDrawerContent">
      <header className="drawerHeader mobileDrawerHeader">
        <h2>会话列表</h2>
        <div>
          {isOwner ? (
            <button
              className="drawerNewButton"
              type="button"
              aria-label="返回完整会话列表"
              title="返回完整会话列表"
              onClick={onOpenList}
            >
              全部会话
            </button>
          ) : null}
          <button ref={closeButtonRef} className="iconButton" type="button" aria-label="关闭会话列表" title="关闭" onClick={onClose}>
            <UiIcon name="close" />
          </button>
        </div>
      </header>

      <div className="mobileDrawerSessionBrowser">
        <SessionBrowser
            taskPanel={taskPanel}
          sessions={sessions}
          tasks={tasks}
          search={search}
          loadingSessions={loading}
          hasMoreSessions={hasMoreSessions}
          loadingMoreSessions={loadingMoreSessions}
          onLoadMoreSessions={onLoadMoreSessions}
          sessionError={error}
          selectedSessionId={selectedSessionId}
          showHeading={false}
          onSearchChange={onSearchChange}
          onSearchSubmit={onSearchSubmit}
          onSelect={onSelect}
          mode={mode}
          onModeChange={onModeChange}
          onMetadataSaved={onMetadataSaved}
          onCreateSession={onCreateSession}
          creatingSessionWorkspace={creatingSessionWorkspace}
          createSessionError={createSessionError}
        />
      </div>

      {isOwner ? (
        <footer className="drawerUtility">
          <button type="button" aria-label="打开设置和诊断" onClick={onOpenSettings}>
            <UiIcon name="settings" />
            <span>设置与诊断</span>
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
  visibleCount,
  tasks,
  selectedSessionId,
  workspaceFilterId,
  mode,
  onSelect,
  onMetadataSaved,
  onCreateSession,
  creatingSessionWorkspace
}: {
  sessions: SessionSummary[];
  visibleCount: number;
  tasks: TaskSummary[];
  selectedSessionId: string | null;
  workspaceFilterId: string;
  mode: SessionListMode;
  onSelect: (session: SessionSummary) => void;
  onMetadataSaved: (session: SessionSummary) => void;
  onCreateSession?: (workspace: string) => Promise<void>;
  creatingSessionWorkspace?: string | null;
}) {
  const [workspaceVisibleCount, setWorkspaceVisibleCount] = useState(DEFAULT_VISIBLE_GROUP_SESSIONS);
  const [unassignedOpen, setUnassignedOpen] = useState(false);
  const [unassignedVisibleCount, setUnassignedVisibleCount] = useState(10);
  const [copiedWorkspace, setCopiedWorkspace] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const orderedSessions = useMemo(() => sortSessionsByWorkspace(sessions), [sessions]);
  const groups = useMemo(() => groupSessionsByWorkspace(orderedSessions), [orderedSessions]);
  const recentSessions = useMemo(() => sortSessionsByUpdatedAt(sessions).slice(0, visibleCount), [sessions, visibleCount]);
  const taskGroups = useMemo(() => {
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const assigned = new Set<string>();
    const groups = tasks.map((task) => {
      const taskSessions = task.sessionIds
        .map((sessionId) => sessionMap.get(sessionId))
        .filter((session): session is SessionSummary => Boolean(session));
      taskSessions.forEach((session) => assigned.add(session.id));
      return { task, sessions: sortSessionsByUpdatedAt(taskSessions) };
    }).filter((group) => group.sessions.length > 0);
    const unassigned = sortSessionsByUpdatedAt(sessions.filter((session) => !assigned.has(session.id)));
    return { groups, unassigned };
  }, [sessions, tasks]);
  const activeWorkspace = groups.some((group) => group.workspace === selectedWorkspace)
    ? selectedWorkspace
    : sortSessionsByUpdatedAt(sessions)[0]?.workspace.trim() || groups[0]?.workspace || "";
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

  useEffect(() => setWorkspaceVisibleCount(DEFAULT_VISIBLE_GROUP_SESSIONS), [activeWorkspace]);

  return (
    <div className="sessionList">
      {mode === "workspace" && activeGroup ? (
        <div className="workspaceFilterRow">
          <label htmlFor={workspaceFilterId}>工作目录</label>
          <div className="workspaceSelectControl">
            <select
              id={workspaceFilterId}
              aria-label="按工作目录筛选"
              value={activeWorkspace}
              onChange={(event) => setSelectedWorkspace(event.target.value)}
            >
              {groups.map((group) => (
                <option value={group.workspace} key={group.workspace}>
                  {workspaceDisplayName(group.workspace)} · {group.sessions.length} 个会话
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
          <p className="workspacePath"><span>Codex 服务所在机器上的路径（不是手机目录）</span><code>{activeGroup.workspace}</code></p>
        </div>
      ) : null}

      {mode === "workspace" && activeGroup ? (() => {
        const visibleSessions = activeGroup.sessions.slice(0, workspaceVisibleCount);
        const hiddenCount = activeGroup.sessions.length - visibleSessions.length;

        return (
          <section className="sessionWorkspaceGroup" aria-label={`${activeGroup.workspace} 的会话`}>
            <div className="workspaceGroupSummary">
              <p className="muted">
                {activeGroup.sessions.length} 个会话 · 已显示 {visibleSessions.length} 个
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
              <button className="ghostButton workspaceToggleButton" type="button" onClick={() => setWorkspaceVisibleCount((count) => hiddenCount > 0 ? count + 20 : DEFAULT_VISIBLE_GROUP_SESSIONS)}>
                {hiddenCount > 0 ? `显示更多会话（剩余 ${hiddenCount} 个）` : "收起会话"}
              </button>
            ) : null}
          </section>
        );
      })() : null}

      {mode === "recent" ? (
        <section className="sessionWorkspaceGroup recentSessionGroup" aria-label="最近修改的会话">
          <div className="workspaceGroupSummary">
            <p className="muted">最近更新 · {recentSessions.length} 个会话</p>
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

      {mode === "task" ? (
        <section className="taskSessionGroups" aria-label="按任务查看会话">
          {taskGroups.unassigned.length > 0 ? (
            <section className="sessionWorkspaceGroup unassignedGroup" aria-label="未归类会话">
              <button className="unassignedToggle" type="button" aria-expanded={unassignedOpen} onClick={() => setUnassignedOpen((value) => !value)}><span>未归类会话 <small>{taskGroups.unassigned.length} 个</small></span><span>{unassignedOpen ? "收起 ↑" : "展开 ↓"}</span></button>
              {unassignedOpen ? <div className="workspaceGroupList">
                {taskGroups.unassigned.slice(0, unassignedVisibleCount).map((session) => (
                  <SessionItem key={session.id} session={session} selected={isSameSession(session, selectedSessionId)} onSelect={onSelect} onMetadataSaved={onMetadataSaved} />
                ))}
              </div> : null}
              {unassignedOpen && unassignedVisibleCount < taskGroups.unassigned.length ? <button className="ghostButton sessionLoadMore" type="button" onClick={() => setUnassignedVisibleCount((count) => count + 20)}>显示更多未归类会话</button> : null}
            </section>
          ) : null}
          {taskGroups.groups.length === 0 && taskGroups.unassigned.length === 0 ? <div className="emptyState">暂无任务会话</div> : null}
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
              className="sessionOpenButton"
              type="button"
              aria-label={`打开会话：${session.title}`}
              title={session.title}
              onClick={() => onSelect(session)}
            >
              <span className="sessionTitleRow"><span className="sessionTitleText">{session.title}</span>{session.status !== "history" ? <StatusBadge status={session.status} /> : null}</span>
              <span className="sessionSummary">{session.summary}</span>
              <span className="sessionMeta">
                <span title={session.workspace}><UiIcon name="folder" />{workspaceDisplayName(session.workspace)}</span>
                <time dateTime={session.updatedAt}>{formatDateTime(session.updatedAt)}</time>
              </span>
            </button>
          )}
        {error ? <div className="errorText">{error}</div> : null}
      </div>
      <div className="sessionActions">
        <button className="iconButton titleEditButton" type="button" aria-label={`编辑 ${session.title} 的备注标题`} title="修改备注标题" onClick={beginTitleEdit} disabled={saving}>{saving ? "…" : <UiIcon name="pencil" />}</button>
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
      const Heading = (`h${block.level}` as "h1" | "h2" | "h3");
      return <Heading key={index}>{renderInlineMarkdown(block.text)}</Heading>;
    }
    case "code":
      return (
        <div className="markdownCode" key={index}>
          {block.language ? <span>{block.language}</span> : null}
          <pre tabIndex={0}><code>{block.text}</code></pre>
        </div>
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
  action,
  children,
  reserveFloatingStatus = false,
  desktopWorkspace = false
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  reserveFloatingStatus?: boolean;
  desktopWorkspace?: boolean;
}) {
  return (
    <main className={`appShell${reserveFloatingStatus ? " reserveFloatingStatus" : ""}${desktopWorkspace ? " desktopWorkspaceShell" : ""}`}>
      <header className="topbar">
        <div className="topbarLeading">
          <span className="brandMark"><UiIcon name="terminal" /></span>
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
    case "queued":
      return "已入队";
    case "unknown":
      return "投递待确认";
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
    case "waiting_user":
      return "等待你回答";
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
