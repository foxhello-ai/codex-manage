import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import type { DesktopStatus } from "../shared/types";
import "./styles.css";

function DesktopApp() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [accountMode, setAccountMode] = useState<"login" | "register">("login");
  const [identityType, setIdentityType] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.codexDesktop.getStatus()
      .then((next) => active && setStatus(next))
      .catch((caught) => active && setError(errorMessage(caught)));
    const unsubscribe = window.codexDesktop.onStatus((next) => {
      if (!active) return;
      setStatus(next);
      if (next.tunnel.state !== "online") {
        setPairingUrl(null);
        setQrCode(null);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const tunnelLabel = useMemo(() => {
    const labels: Record<string, string> = {
      idle: "未启动",
      starting: "启动中",
      online: "在线",
      reconnecting: "重连中",
      stopped: "已停止",
      failed: "启动失败"
    };
    return status ? labels[status.tunnel.state] ?? status.tunnel.state : "读取中";
  }, [status]);

  async function run(action: () => Promise<DesktopStatus>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setError("密码至少需要 8 个字符");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    await run(() => window.codexDesktop.setupPassword(password));
    setPassword("");
    setConfirmation("");
  }

  async function createPairingQr() {
    setBusy(true);
    setError(null);
    try {
      const pairing = await window.codexDesktop.createPairingUrl();
      setPairingUrl(pairing.url);
      setPairingExpiresAt(pairing.expiresAt);
      setQrCode(await QRCode.toDataURL(pairing.url, {
        width: 320,
        margin: 2,
        color: { dark: "#0e2433", light: "#ffffff" }
      }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function requestVerificationCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.codexDesktop.requestVerificationCode(identityType, identifier);
      setVerificationNotice(
        result.debugCode
          ? `验证码已生成（开发模式：${result.debugCode}）`
          : `验证码已发送，有效期至 ${new Date(result.expiresAt).toLocaleTimeString()}`
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = accountMode === "login"
        ? await window.codexDesktop.loginAccount(identifier, accountPassword)
        : await window.codexDesktop.registerAccount(identityType, identifier, verificationCode, accountPassword);
      setStatus(next);
      setAccountPassword("");
      setVerificationCode("");
      setVerificationNotice(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function unbindDevice() {
    if (!window.confirm("确认解绑当前设备？远程通道和已授权手机会话将立即失效，之后需要重新登录并绑定。")) return;
    await run(() => window.codexDesktop.unbindDevice());
  }

  async function exportDiagnostics() {
    setBusy(true);
    setError(null);
    setDiagnosticNotice(null);
    try {
      const file = await window.codexDesktop.exportDiagnosticLogs();
      if (file) setDiagnosticNotice(`诊断日志已导出：${file}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <main className="loading">正在启动 Codex Manage…</main>;
  }

  return (
    <main className="appShell">
      <header className="hero">
        <div>
          <p className="eyebrow">CODEX MANAGE DESKTOP</p>
          <h1>从手机安全访问本机 Codex</h1>
          <p>本机数据不会上传到控制后台，远程访问由 Cloudflare Tunnel 转发。</p>
        </div>
        <span className="version">v{status.version} · {status.platform}/{status.arch}</span>
      </header>

      {error ? <div className="errorBanner" role="alert">{error}</div> : null}

      {status.auth.setupRequired ? (
        <section className="panel setupPanel">
          <div>
            <p className="sectionTag">首次启动</p>
            <h2>设置本机访问密码</h2>
            <p>完成密码设置后才允许启动公网体验通道。</p>
          </div>
          <form onSubmit={handleSetup}>
            <label>
              访问密码
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 个字符" />
            </label>
            <label>
              确认密码
              <input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入密码" />
            </label>
            <button className="primary" disabled={busy || status.localService.state !== "running"}>保存密码</button>
          </form>
        </section>
      ) : null}

      {!status.account.authenticated ? (
        <section className="panel accountPanel">
          <div>
            <p className="sectionTag">平台账号</p>
            <h2>{accountMode === "login" ? "登录设备管理平台" : "注册免费体验账号"}</h2>
            <p>平台只记录账号、设备、域名和 Tunnel 状态，不上传 Codex 会话。</p>
            <div className="segmented">
              <button className={accountMode === "login" ? "selected" : ""} onClick={() => setAccountMode("login")}>登录</button>
              <button className={accountMode === "register" ? "selected" : ""} onClick={() => setAccountMode("register")}>注册</button>
            </div>
          </div>
          <form onSubmit={submitAccount}>
            {accountMode === "register" ? (
              <div className="segmented">
                <button type="button" className={identityType === "email" ? "selected" : ""} onClick={() => setIdentityType("email")}>邮箱（默认）</button>
                <button type="button" className={identityType === "phone" ? "selected" : ""} onClick={() => setIdentityType("phone")}>手机号</button>
              </div>
            ) : null}
            <label>
              {accountMode === "register" ? (identityType === "email" ? "邮箱" : "手机号") : "邮箱或手机号"}
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder={identityType === "email" ? "name@example.com" : "+8613800138000"} />
            </label>
            {accountMode === "register" ? (
              <div className="codeRow">
                <label>验证码<input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} /></label>
                <button type="button" onClick={() => void requestVerificationCode()} disabled={busy || !identifier}>发送验证码</button>
              </div>
            ) : null}
            <label>密码<input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} /></label>
            {verificationNotice ? <p className="notice">{verificationNotice}</p> : null}
            <button className="primary" disabled={busy || !identifier || !accountPassword || (accountMode === "register" && !verificationCode)}>
              {accountMode === "login" ? "登录平台" : "注册并绑定本机"}
            </button>
          </form>
        </section>
      ) : (
        <section className="panel accountSummary">
          <div>
            <p className="sectionTag">平台账号</p>
            <h2>{status.account.identifier}</h2>
            <p>设备 ID：{status.account.deviceId ?? "注册中"}</p>
            {status.account.error ? <p className="warningText">{status.account.error}</p> : null}
          </div>
          <div className="actions">
            {status.account.entitlements["tunnel.named"] === true && status.account.namedTunnelStatus !== "active" ? (
              <button onClick={() => void run(() => window.codexDesktop.provisionNamedTunnel())} disabled={busy}>申请固定域名</button>
            ) : null}
            <button onClick={() => void run(() => window.codexDesktop.logoutAccount())} disabled={busy}>退出平台账号</button>
            <button className="danger" onClick={() => void unbindDevice()} disabled={busy || !status.account.deviceId}>解绑当前设备</button>
          </div>
        </section>
      )}

      <section className="statusGrid">
        <StatusCard
          title="本地服务"
          state={status.localService.state === "running" ? "运行中" : status.localService.state}
          tone={status.localService.state === "running" ? "success" : status.localService.state === "failed" ? "danger" : "neutral"}
          detail={status.localService.url ?? status.localService.error ?? "正在准备本机服务"}
        />
        <StatusCard
          title="Codex CLI"
          state={status.codex.available ? "可用" : "未检测到"}
          tone={status.codex.available ? "success" : "warning"}
          detail={status.codex.version ?? status.codex.error ?? "请安装 Codex CLI"}
        />
        <StatusCard
          title={status.tunnel.mode === "named" ? "固定域名通道" : "体验通道"}
          state={tunnelLabel}
          tone={status.tunnel.state === "online" ? "success" : status.tunnel.state === "failed" ? "danger" : "neutral"}
          detail={status.tunnel.publicUrl ?? status.tunnel.error ?? (status.account.authenticated ? "尚未启动远程通道" : "请先登录平台账号")}
        />
      </section>

      <section className="panel actionsPanel">
        <div>
          <p className="sectionTag">本机与远程</p>
          <h2>访问控制</h2>
        </div>
        <div className="actions">
          <button onClick={() => void window.codexDesktop.openLocalManage()} disabled={status.localService.state !== "running"}>打开本机管理台</button>
          {status.tunnel.state === "online" || status.tunnel.state === "starting" || status.tunnel.state === "reconnecting" ? (
            <button className="danger" onClick={() => void run(() => window.codexDesktop.stopTunnel())} disabled={busy}>停止远程通道</button>
          ) : (
            <button className="primary" onClick={() => void run(() => window.codexDesktop.startTunnel())} disabled={busy || status.auth.setupRequired || !status.account.authenticated || status.localService.state !== "running"}>启动远程通道</button>
          )}
          <button onClick={() => void createPairingQr()} disabled={busy || status.tunnel.state !== "online"}>生成扫码二维码</button>
        </div>
      </section>

      <section className="panel settingsPanel">
        <div>
          <p className="sectionTag">桌面设置与诊断</p>
          <h2>启动和故障排查</h2>
          <p>诊断日志只记录组件状态和脱敏错误摘要，不包含 Codex 会话与命令内容。</p>
          {diagnosticNotice ? <p className="notice">{diagnosticNotice}</p> : null}
        </div>
        <div className="settingsActions">
          <label className="toggleRow">
            <input
              type="checkbox"
              checked={status.settings.launchAtLogin}
              disabled={busy}
              onChange={(event) => void run(() => window.codexDesktop.setLaunchAtLogin(event.target.checked))}
            />
            开机自动启动并静默进入托盘
          </label>
          <button onClick={() => void exportDiagnostics()} disabled={busy}>导出脱敏诊断日志</button>
        </div>
      </section>

      {qrCode && pairingUrl ? (
        <section className="panel qrPanel">
          <img src={qrCode} alt="手机扫码访问二维码" />
          <div>
            <p className="sectionTag">一次性授权</p>
            <h2>使用手机扫码访问</h2>
            <p>二维码仅可使用一次，默认 5 分钟后失效。</p>
            <code>{status.tunnel.publicUrl}</code>
            {pairingExpiresAt ? <p className="muted">有效期至：{new Date(pairingExpiresAt).toLocaleString()}</p> : null}
            <button onClick={() => navigator.clipboard.writeText(pairingUrl)}>复制授权链接</button>
            <details role="note" className="pwaGuide">
              <summary>💡 iPhone 扫码后如何添加到桌面？</summary>
              <ol>
                <li>用 <strong>Safari</strong> 打开二维码链接（微信/相机扫码后请点右上角选择在 Safari 打开）</li>
                <li>点 Safari 底部中间的 <strong>分享按钮</strong>（<span aria-label="分享">⎋</span>）</li>
                <li>向下滑动找到 <strong>「添加到主屏幕」</strong></li>
                <li>点右上角「添加」即可在桌面生成 Codex 图标，后续一键打开</li>
              </ol>
              <p className="muted">Android 手机用 Chrome 扫码会自动弹出安装提示。</p>
            </details>
          </div>
        </section>
      ) : null}

      <section className="panel planPanel">
        <div>
          <p className="sectionTag">套餐与订阅</p>
          <h2>{status.account.subscription?.planName ?? (status.account.entitlements["tunnel.named"] === true ? "正式版权益" : "免费体验版")}</h2>
          <p>
            {status.account.entitlements["tunnel.named"] === true
              ? "已包含固定域名 Named Tunnel。"
              : "当前提供 Quick Tunnel 体验通道，地址可能变化且无稳定 SLA。"}
          </p>
          <p className="muted">
            {status.account.subscription?.expiresAt
              ? `到期时间：${new Date(status.account.subscription.expiresAt).toLocaleString()}`
              : "到期时间：长期有效或尚未登录"}
          </p>
        </div>
        <button disabled title="V1 暂不接入真实支付">立即升级（即将开放）</button>
      </section>

      <footer>
        Quick Tunnel 由 Cloudflare 提供，仅用于测试体验；正式用户使用 Named Tunnel 固定域名。
      </footer>
    </main>
  );
}

function StatusCard({
  title,
  state,
  detail,
  tone
}: {
  title: string;
  state: string;
  detail: string;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <article className="statusCard">
      <div className="statusHeading">
        <span>{title}</span>
        <strong className={`statusPill ${tone}`}>{state}</strong>
      </div>
      <p>{detail}</p>
    </article>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(<DesktopApp />);
