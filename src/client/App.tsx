import { FormEvent, useEffect, useMemo, useState } from "react";
import { getMe, getPublicConfig, login, logout } from "../shared/api";
import type { PublicConfig, UserSession } from "../shared/models";

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
  const listenAddress = useMemo(() => {
    if (!config) return "读取中";
    return `${config.host}:${config.port}`;
  }, [config]);
  const appServerStatus = config?.appServer
    ? `${config.appServer.status}${config.appServer.initialized ? " / initialized" : ""}`
    : "未连接";

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
          <p className="muted">M0/M1 已完成：项目骨架、配置读取和登录保护。</p>
        </div>
      </section>

      <section className="infoGrid" aria-label="当前配置">
        <InfoItem label="监听地址" value={listenAddress} />
        <InfoItem label="Codex CLI" value={config?.codexCliPath ?? "读取中"} />
        <InfoItem label="Codex 版本" value={config?.codexCliVersion ?? config?.codexVersionError ?? "读取中"} />
        <InfoItem label="App Server" value={appServerStatus} />
        <InfoItem label="Sessions 目录" value={config?.sessionsDir ?? "读取中"} />
      </section>
    </Shell>
  );
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
