import { FormEvent, KeyboardEvent, PointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getMe, getPublicConfig, getSessionCommands, getSessionDetail, getSessionRuntime, getSessionWebSocketUrl, getSessions, login, logout, resumeSession, sendSessionInput, submitApproval, updateSessionMetadata } from "../shared/api";
import type { ApprovalDecision, ApprovalSummary, PublicConfig, RuntimeSnapshot, SessionCommand, SessionCommandDiagnostics, SessionDetail, SessionPermissionMode, SessionSummary, SessionStatus, SessionTurnItem, UserSession, WebSessionEvent } from "../shared/models";

type LoadState = "loading" | "ready" | "error";
type WebSocketStatus = "idle" | "connecting" | "connected" | "disconnected";
type DashboardView = "list" | "detail";

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

type LiveAgentMessage = {
  id: string;
  turnId: string | null;
  itemId: string | null;
  text: string;
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [commandDiagnostics, setCommandDiagnostics] = useState<SessionCommandDiagnostics | null>(null);
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DashboardView>("list");
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [permissionMode, setPermissionMode] = useState<SessionPermissionMode>("default");
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalSummary[]>([]);
  const [liveCommands, setLiveCommands] = useState<LiveCommand[]>([]);
  const [liveMessages, setLiveMessages] = useState<LiveAgentMessage[]>([]);
  const [wsStatus, setWsStatus] = useState<WebSocketStatus>("idle");
  const [wsReconnectKey, setWsReconnectKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const lastEventSeqRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(null);

  const listenAddress = useMemo(() => {
    if (!config) return "读取中";
    return `${config.host}:${config.port}`;
  }, [config]);
  const appServerStatus = config?.appServer
    ? `${config.appServer.status}${config.appServer.initialized ? " / initialized" : ""}`
    : "未连接";
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  async function loadSessions(nextSearch = search) {
    setLoadingSessions(true);
    setSessionError(null);

    try {
      const response = await getSessions(nextSearch);
      setSessions(response.sessions);
      if (selectedSessionId && !response.sessions.some((session) => session.id === selectedSessionId)) {
        setSelectedSessionId(null);
        setViewMode("list");
        setSessionDetail(null);
        setCommands([]);
        setCommandDiagnostics(null);
      }
    } catch (caught) {
      setSessionError(caught instanceof Error ? caught.message : "会话列表加载失败");
    } finally {
      setLoadingSessions(false);
    }
  }

  useEffect(() => {
    loadSessions("");
  }, []);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loadSessions(search);
  }

  async function loadSessionDetail(sessionId: string, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoadingDetail(true);
    setDetailError(null);

    try {
      const response = await getSessionDetail(sessionId);
      setSessionDetail(response.session);
    } catch (caught) {
      if (!options.silent) setSessionDetail(null);
      setDetailError(caught instanceof Error ? caught.message : "会话详情加载失败");
    } finally {
      if (!options.silent) setLoadingDetail(false);
    }
  }

  async function loadSessionCommands(sessionId: string, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoadingCommands(true);
    setCommandsError(null);
    if (!options.silent) setCommandDiagnostics(null);

    try {
      const response = await getSessionCommands(sessionId);
      setCommands(response.commands);
      setCommandDiagnostics(response.diagnostics);
    } catch (caught) {
      if (!options.silent) setCommands([]);
      setCommandsError(caught instanceof Error ? caught.message : "历史命令加载失败");
    } finally {
      if (!options.silent) setLoadingCommands(false);
    }
  }

  function syncRuntimeSnapshot(nextRuntime: RuntimeSnapshot) {
    setRuntime(nextRuntime);
    if (nextRuntime.status !== "history") {
      setPermissionMode(nextRuntime.permissionMode);
    }
  }

  async function loadRuntime(sessionId: string, options: { silent?: boolean } = {}) {
    if (!options.silent) setRuntimeError(null);
    try {
      const response = await getSessionRuntime(sessionId);
      syncRuntimeSnapshot(response.runtime);
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, response.runtime.eventSeq);
    } catch (caught) {
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

  function applyRealtimeEvent(event: WebSessionEvent) {
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
      setLiveMessages((current) => appendLiveMessage(current, { id: itemId, itemId, turnId, text: delta }));
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

  function handleSelectSession(session: SessionSummary) {
    setSelectedSessionId(session.id);
    setSessionDetail(null);
    setCommands([]);
    setCommandDiagnostics(null);
    setRuntime(null);
    setPermissionMode("default");
    setPendingApprovals([]);
    setLiveCommands([]);
    setLiveMessages([]);
    setRuntimeError(null);
    lastEventSeqRef.current = 0;
    setViewMode("detail");
    refreshCurrentSession(session.id);
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

  async function handleSendInput(text: string) {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    setRuntimeError(null);
    try {
      const response = await sendSessionInput(sessionId, text, permissionMode);
      syncRuntimeSnapshot(response.runtime);
      void pollCurrentSessionAfterInput(sessionId);
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "任务发送失败");
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
    setViewMode("list");
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
    <Shell title="Codex Manage" action={<button className="ghostButton" onClick={onLogout}>登出</button>}>
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
              <button className="ghostButton" onClick={() => loadSessions(search)} disabled={loadingSessions}>
                {loadingSessions ? "刷新中" : "刷新"}
              </button>
            </div>
          </section>

          <section className="infoGrid compact" aria-label="当前配置">
            <InfoItem label="监听地址" value={listenAddress} />
            <InfoItem label="Codex 版本" value={config?.codexCliVersion ?? config?.codexVersionError ?? "读取中"} />
            <InfoItem label="App Server" value={appServerStatus} />
          </section>

          <section className="sessionSection" aria-label="会话列表">
            {renderSessionBrowser()}
          </section>
        </>
      ) : (
        <>
          <section className="toolbar detailToolbar">
            <div className="detailTitleBar">
              <button className="iconButton" aria-label="返回会话列表" title="返回会话列表" onClick={handleBackToList}>
                <span aria-hidden="true">←</span>
              </button>
              <div>
                <p className="detailEyebrow">当前会话</p>
                <h2 title={selectedSession?.title ?? "会话不存在或已被过滤"}>{selectedSession?.title ?? "会话不存在或已被过滤"}</h2>
              </div>
            </div>
            <div className="toolbarActions">
              <button className="ghostButton" onClick={handleRefresh} disabled={loadingSessions || loadingDetail || loadingCommands}>
                {loadingSessions || loadingDetail || loadingCommands ? "刷新中" : "刷新"}
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
                wsStatus={wsStatus}
                onResume={handleResume}
                onPermissionModeChange={handlePermissionModeChange}
                onSendInput={handleSendInput}
                onSubmitApproval={handleSubmitApproval}
              />
            ) : (
              <div className="emptyState">会话不存在或已被过滤，请返回会话列表重新选择。</div>
            )}
          </section>
        </>
      )}

      {selectedSession ? (
        <FloatingRuntimeStatus
          sessionTitle={selectedSession.title}
          runtime={runtime}
          wsStatus={wsStatus}
          pendingApprovalCount={pendingApprovals.length}
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

type FloatingPosition = {
  x: number;
  y: number;
};

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
  wsStatus,
  onResume,
  onPermissionModeChange,
  onSendInput,
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
  liveMessages: LiveAgentMessage[];
  wsStatus: WebSocketStatus;
  onResume: () => Promise<void>;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
  onSendInput: (text: string) => Promise<void>;
  onSubmitApproval: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
}) {
  const session = detail ?? fallbackSession;
  const [expandedMessage, setExpandedMessage] = useState<{ title: string; text: string; meta?: string } | null>(null);
  const [visibleTurnCount, setVisibleTurnCount] = useState(DEFAULT_VISIBLE_TURNS);
  const [showHistoryDuringLive, setShowHistoryDuringLive] = useState(false);
  const hasLiveOutput = liveMessages.length > 0 || liveCommands.some((command) => !isLiveCommandCompleted(command));
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
      {runtime?.permissionMode === "full_access" ? (
        pendingApprovals.length > 0 ? <div className="errorBanner">完全权限模式收到未预期的审批请求，系统未自动处理。</div> : null
      ) : (
        <ApprovalPanel approvals={pendingApprovals} onSubmitApproval={onSubmitApproval} />
      )}
      {!showHistoryDuringLive ? (
        <LiveOutputPanel
          liveMessages={liveMessages}
          liveCommands={liveCommands}
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
        onResume={onResume}
        onPermissionModeChange={onPermissionModeChange}
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
  onResume,
  onPermissionModeChange
}: {
  runtime: RuntimeSnapshot | null;
  permissionMode: SessionPermissionMode;
  wsStatus: WebSocketStatus;
  error: string | null;
  onResume: () => Promise<void>;
  onPermissionModeChange: (permissionMode: SessionPermissionMode) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [updatingPermission, setUpdatingPermission] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const status = runtime?.status ?? "history";
  const canChangePermission = status === "history" || status === "waiting_input" || status === "exited" || status === "failed";

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
  onShowHistory
}: {
  liveMessages: LiveAgentMessage[];
  liveCommands: LiveCommand[];
  onShowHistory: () => void;
}) {
  const outputBodyRef = useRef<HTMLDivElement | null>(null);
  const runningCommands = liveCommands.filter((command) => !isLiveCommandCompleted(command));
  const visibleMessages = liveMessages.slice(-MAX_VISIBLE_LIVE_MESSAGES);
  const visibleCommands = runningCommands.slice(-MAX_VISIBLE_LIVE_COMMANDS);
  const hiddenCount = liveMessages.length + runningCommands.length - visibleMessages.length - visibleCommands.length;
  const visibleCount = liveMessages.length + runningCommands.length;

  useEffect(() => {
    const outputBody = outputBodyRef.current;
    if (!outputBody) return;
    outputBody.scrollTop = outputBody.scrollHeight;
  }, [visibleMessages, visibleCommands]);

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
        {visibleMessages.map((message) => (
          <article className="messageItem agent" key={message.id}>
            <div className="messageHeader"><strong>Codex</strong><span>实时</span></div>
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
  const disabled = submitting || runtime?.status === "waiting_approval" || runtime?.status === "starting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextText = text.trim();
    if (!nextText) return;
    setSubmitting(true);
    try {
      await onSend(nextText);
      setText("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="taskInput" onSubmit={handleSubmit}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={runtime?.status === "waiting_approval" ? "请先处理审批" : "输入继续任务内容"}
        disabled={disabled}
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

function Shell({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="appShell">
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

function appendLiveMessage(messages: LiveAgentMessage[], nextMessage: LiveAgentMessage): LiveAgentMessage[] {
  const current = messages.find((message) => message.id === nextMessage.id);
  if (!current) return [...messages, nextMessage];
  return messages.map((message) => (message.id === nextMessage.id ? { ...message, text: `${message.text}${nextMessage.text}` } : message));
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
