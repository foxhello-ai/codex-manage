import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { getMe, getPublicConfig, getSessions, login, logout, updateSessionMetadata } from "../shared/api";
import type { PublicConfig, SessionSummary, SessionStatus, UserSession } from "../shared/models";

type LoadState = "loading" | "ready" | "error";

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
            当前使用默认密码 admin。局域网访问前请设置 CODEX_WEB_PASSWORD。
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
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loadSessions(search);
  }

  function handleSelectSession(session: SessionSummary) {
    setSelectedSessionId(session.id);
    setDrawerOpen(false);
  }

  function handleMetadataSaved(updated: SessionSummary) {
    setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
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
          当前使用默认密码 admin。请通过 CODEX_WEB_PASSWORD 配置强密码。
        </div>
      ) : null}

      <section className="toolbar">
        <div>
          <h2>会话管理</h2>
          <p className="muted">查看 ~/.codex/sessions 中的历史会话，后续阶段将支持详情和恢复。</p>
        </div>
        <div className="toolbarActions">
          <button className="iconButton mobileOnly" aria-label="打开会话列表" title="会话列表" onClick={() => setDrawerOpen(true)}>
            <span aria-hidden="true">☰</span>
          </button>
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

      <section className="sessionDetail" aria-labelledby="session-detail-title">
        <div>
          <h2 id="session-detail-title">当前会话</h2>
          {selectedSession ? (
            <p className="muted">{selectedSession.title}</p>
          ) : (
            <p className="muted">选择一个会话后将在这里继续展示会话内容。</p>
          )}
        </div>
        {selectedSession ? (
          <div className="detailGrid">
            <InfoItem label="工作目录" value={selectedSession.workspace} />
            <InfoItem label="更新时间" value={formatDateTime(selectedSession.updatedAt)} />
            <InfoItem label="会话 ID" value={selectedSession.id} />
          </div>
        ) : null}
      </section>

      <section className="sessionSection desktopSessionPanel" aria-label="会话列表">
        {renderSessionBrowser()}
      </section>

      {drawerOpen ? (
        <div className="drawerBackdrop" role="presentation" onClick={() => setDrawerOpen(false)}>
          <aside className="sessionDrawer" aria-label="会话列表" onClick={(event) => event.stopPropagation()}>
            <div className="drawerHeader">
              <div>
                <h2>会话列表</h2>
                <p className="muted">共 {sessions.length} 个会话</p>
              </div>
              <button className="ghostButton" onClick={() => setDrawerOpen(false)}>
                关闭
              </button>
            </div>
            {renderSessionBrowser(false)}
          </aside>
        </div>
      ) : null}
    </Shell>
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
  return (
    <div className="sessionList">
      {sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          selected={session.id === selectedSessionId}
          onSelect={onSelect}
          onMetadataSaved={onMetadataSaved}
        />
      ))}
    </div>
  );
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
