import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import type { DesktopStatus, IssueReportCategory, UpdateStatus } from "../shared/types";
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
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [issuePanelOpen, setIssuePanelOpen] = useState(false);
  const [issueCategory, setIssueCategory] = useState<IssueReportCategory>("defect");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueNotice, setIssueNotice] = useState<string | null>(null);

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

  async function updateLaunchAtLogin(enabled: boolean) {
    setBusy(true);
    setError(null);
    setSettingsNotice(null);
    try {
      const next = await window.codexDesktop.setLaunchAtLogin(enabled);
      setStatus(next);
      setSettingsNotice(enabled
        ? "已开启开机自动启动；下次登录系统后会在后台启动，可从菜单栏或系统托盘打开。"
        : "已关闭开机自动启动。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateIssueAutoReport(enabled: boolean) {
    setBusy(true);
    setError(null);
    setSettingsNotice(null);
    try {
      const next = await window.codexDesktop.setIssueAutoReportEnabled(enabled);
      setStatus(next);
      setSettingsNotice(enabled ? "已开启自动上报崩溃和不可用问题。" : "已关闭自动上报。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function checkForUpdates() {
    setBusy(true);
    setError(null);
    setUpdateNotice(null);
    try {
      const update = await window.codexDesktop.checkForUpdates();
      setUpdateNotice(updateMessage(update));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function installUpdate() {
    if (!window.confirm("确认立即重启并安装更新？本地服务和远程通道会先停止。")) return;
    setBusy(true);
    setError(null);
    setUpdateNotice("正在关闭本地服务并触发系统安装器，macOS 可能需要几十秒。");
    try {
      await window.codexDesktop.installUpdate();
      setUpdateNotice("安装命令已发出，请等待应用自动退出并重启。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitIssueReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIssueNotice(null);
    try {
      const result = await window.codexDesktop.submitIssueReport({
        category: issueCategory,
        title: issueTitle,
        description: issueDescription
      });
      setIssueNotice(result.queued
        ? "当前网络不可用，问题已进入本地队列，恢复后自动补发"
        : `问题已上报，编号：${result.reportId}`);
      setIssueTitle("");
      setIssueDescription("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <main className="loading">正在启动 Codex Manage…</main>;
  }

  const setupRequired = status.auth.ready && status.auth.setupRequired;
  const localAccessBlocked = !status.auth.ready || status.auth.setupRequired;
  const launchAtLoginLabel = status.settings.launchAtLogin ? "已开启" : "未开启";
  const issueAutoReportLabel = status.issueReporting.autoEnabled ? "已开启" : "未开启";

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

      {setupRequired ? (
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
            <button className="primary" onClick={() => void run(() => window.codexDesktop.startTunnel())} disabled={busy || localAccessBlocked || !status.account.authenticated || status.localService.state !== "running"}>启动远程通道</button>
          )}
          <button onClick={() => void createPairingQr()} disabled={busy || status.tunnel.state !== "online"}>生成扫码二维码</button>
        </div>
      </section>

      <section className="panel settingsPanel">
        <div>
          <p className="sectionTag">桌面设置</p>
          <h2>启动和问题处理</h2>
          <p>这里保留客户能直接操作的设置。需要排查时，点击上报问题会自动附带脱敏运行信息。</p>
          {settingsNotice ? <p className="notice">{settingsNotice}</p> : null}
          {updateNotice ? <p className="notice">{updateNotice}</p> : null}
        </div>
        <div className="settingsActions">
          <div className="settingCard">
            <div>
              <strong>开机自动启动</strong>
              <span>下次登录系统后在后台启动，可从菜单栏或系统托盘打开。</span>
            </div>
            <button type="button" onClick={() => void updateLaunchAtLogin(!status.settings.launchAtLogin)} disabled={busy}>
              {launchAtLoginLabel}
            </button>
          </div>
          <div className="settingCard">
            <div>
              <strong>自动问题上报</strong>
              <span>仅上报崩溃、不可用和脱敏运行摘要，不包含 Codex 会话正文。</span>
            </div>
            <button type="button" onClick={() => void updateIssueAutoReport(!status.issueReporting.autoEnabled)} disabled={busy}>
              {issueAutoReportLabel}
            </button>
          </div>
          {status.issueReporting.queuedCount > 0 ? <span className="queueHint">待补发 {status.issueReporting.queuedCount} 条</span> : null}
          <div className="updateBox">
            <strong>{updateLabel(status.update)}</strong>
            <span>{updateDetail(status.update)}</span>
          </div>
          {status.update.state === "downloaded" ? (
            <button className="primary" onClick={() => void installUpdate()} disabled={busy}>重启安装更新</button>
          ) : (
            <button onClick={() => void checkForUpdates()} disabled={busy || ["checking", "downloading", "installing"].includes(status.update.state)}>
              {updateActionLabel(status.update)}
            </button>
          )}
          <button className="primary" type="button" onClick={() => setIssuePanelOpen(true)} disabled={busy}>上报问题</button>
        </div>
      </section>

      <button
        className="issueBubble"
        type="button"
        aria-label="打开问题反馈"
        onClick={() => setIssuePanelOpen(true)}
      >
        <span>?</span>
        {status.issueReporting.queuedCount > 0 ? <em>{status.issueReporting.queuedCount}</em> : null}
      </button>

      {issuePanelOpen ? (
        <section className="issuePopover" role="dialog" aria-modal="false" aria-labelledby="issue-report-title">
          <div className="issuePopoverHeader">
            <div>
              <p className="sectionTag">问题反馈</p>
              <h2 id="issue-report-title">上报问题</h2>
            </div>
            <button className="closeButton" type="button" aria-label="关闭问题反馈" onClick={() => setIssuePanelOpen(false)}>×</button>
          </div>
          <p>提交后会自动附带脱敏运行快照和最近诊断摘要，不上传 Codex 会话正文、命令输出或项目文件内容。</p>
          {issueNotice ? <p className="notice">{issueNotice}</p> : null}
          {status.issueReporting.lastError ? <p className="warningText">上次上报失败：{status.issueReporting.lastError}</p> : null}
          <form onSubmit={submitIssueReport}>
            <label>
              问题类型
              <select value={issueCategory} onChange={(event) => setIssueCategory(event.target.value as IssueReportCategory)}>
                <option value="defect">功能缺陷</option>
                <option value="unavailable">服务不可用</option>
                <option value="optimization">体验优化</option>
                <option value="requirement">功能需求</option>
                <option value="crash">崩溃</option>
              </select>
            </label>
            <label>
              标题
              <input value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} maxLength={160} placeholder="例如：Windows 首次启动本地服务失败" />
            </label>
            <label>
              问题描述
              <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} maxLength={4000} rows={5} placeholder="请描述复现步骤、期望结果和实际现象" />
            </label>
            <button className="primary" disabled={busy || !status.account.authenticated || !issueTitle.trim() || !issueDescription.trim()}>
              {status.account.authenticated ? "提交问题" : "登录后可上报"}
            </button>
          </form>
        </section>
      ) : null}

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

function updateLabel(update: UpdateStatus): string {
  const labels: Record<UpdateStatus["state"], string> = {
    idle: "更新：待检查",
    checking: "更新：检查中",
    not_available: "更新：已是最新",
    available: "更新：发现新版本",
    downloading: "更新：下载中",
    downloaded: "更新：已下载",
    installing: "更新：安装中",
    error: "更新：失败"
  };
  return labels[update.state];
}

function updateDetail(update: UpdateStatus): string {
  if (update.state === "downloading") return `进度 ${update.progressPercent ?? 0}%`;
  if (update.state === "installing") return "正在关闭本地服务并触发系统安装器，macOS 可能需要几十秒";
  if (update.targetVersion) return `目标版本 ${update.targetVersion}`;
  if (update.lastCheckedAt) return `上次检查 ${new Date(update.lastCheckedAt).toLocaleString()}`;
  return `当前版本 ${update.currentVersion}`;
}

function updateActionLabel(update: UpdateStatus): string {
  if (update.state === "downloading") return "下载中";
  if (update.state === "installing") return "安装中";
  return "检查并更新";
}

function updateMessage(update: UpdateStatus): string {
  if (update.state === "not_available") return "当前已是最新版本";
  if (update.state === "downloaded") return "新版本已下载，可立即重启安装";
  if (update.state === "error") return update.error ?? "更新检查失败";
  return updateDetail(update);
}

createRoot(document.getElementById("root")!).render(<DesktopApp />);
