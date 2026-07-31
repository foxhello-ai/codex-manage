import { FormEvent, ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveApiBase } from "./apiBase";
import "./styles.css";

type Tab = "overview" | "users" | "devices" | "tunnels" | "domains" | "subscriptions" | "orders" | "payments" | "issue-reports" | "system-config" | "audit";
type JsonRecord = Record<string, unknown>;
type RuntimeAdminConfig = {
  controlApiUrl?: string;
  controlApiPort?: string;
};
type SystemConfig = {
  publicApiBaseUrl: string;
  desktopUpdateFeedUrl: string;
  deviceDomain: string;
  managedDomainSuffixes: string[];
  adminOrigins: string[];
  desktopConfigTtlSeconds: number;
  cloudflareZoneId: string | null;
  updatedAt: string | null;
  updatedByAdminId: string | null;
};

const runtimeConfig = (window as Window & { CODEX_ADMIN_CONFIG?: RuntimeAdminConfig }).CODEX_ADMIN_CONFIG;
const apiBase = resolveApiBase(
  runtimeConfig?.controlApiUrl || import.meta.env.VITE_CONTROL_API_URL,
  window.location,
  runtimeConfig?.controlApiPort || import.meta.env.VITE_CONTROL_API_PORT || "4320"
);

function AdminApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem("codex-admin-token"));
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function load(nextTab: Tab = tab) {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const path = nextTab === "overview"
        ? "/v1/admin/overview"
        : nextTab === "audit" ? "/v1/admin/audit-logs" : `/v1/admin/${nextTab}`;
      setData(await request(path, {}, token));
      setTab(nextTab);
      setSearch("");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      if (message.includes("登录") || message.includes("401")) {
        sessionStorage.removeItem("codex-admin-token");
        setToken(null);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) void load("overview");
  }, [token]);

  if (!token) {
    return <Login onLoggedIn={(nextToken) => {
      sessionStorage.setItem("codex-admin-token", nextToken);
      setToken(nextToken);
    }} />;
  }

  const rows = extractRows(tab, data).filter((row) =>
    !search.trim() || JSON.stringify(row).toLowerCase().includes(search.trim().toLowerCase())
  );
  return (
    <div className="adminShell">
      <aside>
        <div className="brand"><span>CM</span><strong>运营后台</strong></div>
        <nav>
          {(["overview", "users", "devices", "tunnels", "domains", "subscriptions", "orders", "payments", "issue-reports", "system-config", "audit"] as Tab[]).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => void load(item)}>
              {tabLabel(item)}
            </button>
          ))}
        </nav>
        <button className="logout" onClick={() => {
          sessionStorage.removeItem("codex-admin-token");
          setToken(null);
        }}>退出登录</button>
      </aside>
      <main>
        <header>
          <div><p>CODEX MANAGE</p><h1>{tabLabel(tab)}</h1></div>
          <div className="headerActions">
            {tab !== "overview" && tab !== "system-config" ? <input aria-label="搜索当前列表" placeholder="搜索当前列表" value={search} onChange={(event) => setSearch(event.target.value)} /> : null}
            <button onClick={() => void load(tab)}>刷新</button>
          </div>
        </header>
        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="empty">正在载入…</div> : tab === "overview" ? (
          <Overview data={(data ?? {}) as JsonRecord} />
        ) : tab === "system-config" ? (
          <SystemConfigPanel config={(data as { systemConfig?: SystemConfig } | null)?.systemConfig ?? null} token={token} onSaved={() => void load("system-config")} />
        ) : (
          <DataTable rows={rows} token={token} onChanged={() => void load(tab)} tab={tab} />
        )}
      </main>
    </div>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await request("/v1/admin/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      }) as { accessToken: string };
      onLoggedIn(result.accessToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="loginPage">
      <form className="loginCard" onSubmit={submit}>
        <p>CODEX MANAGE</p>
        <h1>运营后台登录</h1>
        <label>管理员邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error ? <div className="error">{error}</div> : null}
        <button disabled={busy || !email || !password}>{busy ? "登录中" : "登录"}</button>
      </form>
    </main>
  );
}

function Overview({ data }: { data: JsonRecord }) {
  const cards = [
    ["注册用户", data.users],
    ["邮箱用户", data.email_users],
    ["手机用户", data.phone_users],
    ["今日新增", data.users_today],
    ["绑定设备", data.devices],
    ["在线设备", data.online_devices],
    ["Quick Tunnel", data.quick_tunnels],
    ["Named Tunnel", data.named_tunnels],
    ["固定域名", data.fixed_domains],
    ["正式权益用户", data.formal_users],
    ["未关闭问题", data.open_issue_reports],
    ["主动反馈", data.manual_issue_reports]
  ];
  return <section className="overview">{cards.map(([label, value]) => <article key={String(label)}><span>{String(label)}</span><strong>{String(value ?? 0)}</strong></article>)}</section>;
}

function SystemConfigPanel({ config, token, onSaved }: { config: SystemConfig | null; token: string; onSaved: () => void }) {
  const [publicApiBaseUrl, setPublicApiBaseUrl] = useState(config?.publicApiBaseUrl ?? "");
  const [desktopUpdateFeedUrl, setDesktopUpdateFeedUrl] = useState(config?.desktopUpdateFeedUrl ?? "");
  const [deviceDomain, setDeviceDomain] = useState(config?.deviceDomain ?? "");
  const [managedDomainSuffixes, setManagedDomainSuffixes] = useState((config?.managedDomainSuffixes ?? []).join("\n"));
  const [adminOrigins, setAdminOrigins] = useState((config?.adminOrigins ?? []).join("\n"));
  const [desktopConfigTtlSeconds, setDesktopConfigTtlSeconds] = useState(String(config?.desktopConfigTtlSeconds ?? 3600));
  const [cloudflareZoneId, setCloudflareZoneId] = useState(config?.cloudflareZoneId ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPublicApiBaseUrl(config?.publicApiBaseUrl ?? "");
    setDesktopUpdateFeedUrl(config?.desktopUpdateFeedUrl ?? "");
    setDeviceDomain(config?.deviceDomain ?? "");
    setManagedDomainSuffixes((config?.managedDomainSuffixes ?? []).join("\n"));
    setAdminOrigins((config?.adminOrigins ?? []).join("\n"));
    setDesktopConfigTtlSeconds(String(config?.desktopConfigTtlSeconds ?? 3600));
    setCloudflareZoneId(config?.cloudflareZoneId ?? "");
  }, [config]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm("确认保存系统域名配置？保存后会立即影响桌面配置下发和新固定域名签发，请确认 DNS 与 Cloudflare Zone 已准备好。")) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await request("/v1/admin/system-config", {
        method: "PATCH",
        body: JSON.stringify({
          publicApiBaseUrl,
          desktopUpdateFeedUrl,
          deviceDomain,
          managedDomainSuffixes: parseLines(managedDomainSuffixes),
          adminOrigins: parseLines(adminOrigins),
          desktopConfigTtlSeconds: Number.parseInt(desktopConfigTtlSeconds, 10),
          cloudflareZoneId: cloudflareZoneId.trim() || null
        })
      }, token);
      setMessage("系统配置已保存，服务端无需重启。桌面端会在配置 TTL 到期后自动刷新。");
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!config) return <div className="empty">暂无系统配置</div>;
  return (
    <form className="configPanel" onSubmit={submit}>
      <section>
        <h2>业务域名</h2>
        <p>这些配置保存在数据库，保存后由服务端实时读取，不需要修改 `.env` 或重启服务。</p>
        <label>控制 API 地址<input value={publicApiBaseUrl} onChange={(event) => setPublicApiBaseUrl(event.target.value)} placeholder="https://codex-api.example.com" /></label>
        <label>桌面更新源<input value={desktopUpdateFeedUrl} onChange={(event) => setDesktopUpdateFeedUrl(event.target.value)} placeholder="https://codex-api.example.com/updates/stable" /></label>
        <label>设备固定域名根域名<input value={deviceDomain} onChange={(event) => setDeviceDomain(event.target.value)} placeholder="example.com" /></label>
        <label>托管域名后缀<textarea value={managedDomainSuffixes} onChange={(event) => setManagedDomainSuffixes(event.target.value)} rows={4} placeholder={"example.com\nold-domain.com"} /></label>
      </section>
      <section>
        <h2>后台与 Cloudflare</h2>
        <label>后台允许访问 Origin<textarea value={adminOrigins} onChange={(event) => setAdminOrigins(event.target.value)} rows={4} placeholder={"https://codex-admin.example.com\nhttp://192.168.31.107"} /></label>
        <label>桌面配置刷新 TTL（秒）<input type="number" min={60} max={86400} value={desktopConfigTtlSeconds} onChange={(event) => setDesktopConfigTtlSeconds(event.target.value)} /></label>
        <label>Cloudflare Zone ID<input value={cloudflareZoneId} onChange={(event) => setCloudflareZoneId(event.target.value)} placeholder="切换根域名时填写新 Zone ID" /></label>
        <div className="configMeta">最近更新：{config.updatedAt ?? "尚未写入数据库"}{config.updatedByAdminId ? ` / 操作人：${config.updatedByAdminId}` : ""}</div>
      </section>
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="success">{message}</div> : null}
      <div className="formActions">
        <button disabled={busy}>{busy ? "保存中" : "保存配置"}</button>
      </div>
    </form>
  );
}

function DataTable({ rows, token, onChanged, tab }: { rows: JsonRecord[]; token: string; onChanged: () => void; tab: Tab }) {
  if (!rows.length) return <div className="empty">暂无数据</div>;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 10);
  return (
    <div className="tableWrap">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}{tab === "users" || tab === "devices" || tab === "tunnels" || tab === "issue-reports" ? <th>操作</th> : null}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={String(row.id ?? index)}>
            {columns.map((column) => <td key={column}>{formatValue(row[column])}</td>)}
            {tab === "users" ? <td className="rowActions"><GrantButton userId={String(row.id)} token={token} onChanged={onChanged} /><StatusButton kind="users" id={String(row.id)} current={String(row.status)} token={token} onChanged={onChanged} /></td> : null}
            {tab === "devices" ? <td><StatusButton kind="devices" id={String(row.id)} current={String(row.status)} token={token} onChanged={onChanged} /></td> : null}
            {tab === "tunnels" ? <td><RebuildTunnelButton id={String(row.id)} mode={String(row.mode)} token={token} onChanged={onChanged} /></td> : null}
            {tab === "issue-reports" ? <td><IssueReportActions id={String(row.id)} status={String(row.status)} token={token} onChanged={onChanged} /></td> : null}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function IssueReportActions({ id, status, token, onChanged }: { id: string; status: string; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function viewDetail() {
    setBusy(true);
    try {
      const detail = await request(`/v1/admin/issue-reports/${encodeURIComponent(id)}`, {}, token);
      window.alert(JSON.stringify(detail, null, 2));
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus() {
    const next = window.prompt("请输入新状态：new / triaged / in_progress / waiting_user / resolved / closed / ignored", status);
    if (!next) return;
    const note = window.prompt("请输入处理备注", "");
    setBusy(true);
    try {
      await request(`/v1/admin/issue-reports/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next, note: note || null })
      }, token);
      onChanged();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rowActions">
      <button className="small" disabled={busy} onClick={() => void viewDetail()}>详情</button>
      <button className="small" disabled={busy} onClick={() => void updateStatus()}>分诊</button>
    </div>
  );
}

function RebuildTunnelButton({ id, mode, token, onChanged }: { id: string; mode: string; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function rebuild() {
    const reason = window.prompt("请输入重建 Tunnel 的原因", "重新签发设备 Tunnel Token");
    if (!reason || !window.confirm("确认撤销并重建该 Named Tunnel？旧域名会在重建期间短暂不可用。")) return;
    setBusy(true);
    try {
      await request(`/v1/admin/tunnels/${encodeURIComponent(id)}/rebuild`, {
        method: "POST",
        body: JSON.stringify({ reason })
      }, token);
      onChanged();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return <button className="small" disabled={busy || mode !== "named"} onClick={() => void rebuild()}>重建并换 Token</button>;
}

function GrantButton({ userId, token, onChanged }: { userId: string; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function grant() {
    const reason = window.prompt("请输入人工开通原因", "内测用户");
    if (!reason) return;
    const expires = window.prompt("请输入到期时间（ISO，可留空表示长期）", "");
    if (!window.confirm("确认人工开通正式权益？该操作将写入审计日志。")) return;
    setBusy(true);
    try {
      await request(`/v1/admin/users/${encodeURIComponent(userId)}/formal-subscription`, {
        method: "POST",
        body: JSON.stringify({ expiresAt: expires || null, reason })
      }, token);
      onChanged();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return <button className="small" disabled={busy} onClick={() => void grant()}>开通正式权益</button>;
}

function StatusButton({ kind, id, current, token, onChanged }: { kind: "users" | "devices"; id: string; current: string; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const next = current === "blocked" ? "active" : "blocked";
  async function update() {
    const reason = window.prompt(`请输入${next === "blocked" ? "停用" : "恢复"}原因`, next === "blocked" ? "管理员操作" : "问题已处理");
    if (!reason) return;
    if (!window.confirm(`确认${next === "blocked" ? "停用" : "恢复"}该${kind === "users" ? "用户" : "设备"}？`)) return;
    setBusy(true);
    try {
      await request(`/v1/admin/${kind}/${encodeURIComponent(id)}/status`, {
        method: "POST",
        body: JSON.stringify({ status: next, reason })
      }, token);
      onChanged();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return <button className={next === "blocked" ? "small dangerButton" : "small"} disabled={busy} onClick={() => void update()}>{next === "blocked" ? "停用" : "恢复"}</button>;
}

async function request(path: string, init: RequestInit = {}, token?: string): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `请求失败：${response.status}`);
  return body;
}

function extractRows(tab: Tab, data: unknown): JsonRecord[] {
  if (!data || typeof data !== "object") return [];
  const key = tab === "audit" ? "auditLogs" : tab === "issue-reports" ? "issueReports" : tab;
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as JsonRecord[] : [];
}

function parseLines(value: string): string[] {
  return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function formatValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return <code>{JSON.stringify(value)}</code>;
  return String(value);
}

function tabLabel(tab: Tab): string {
  return ({
    overview: "数据概览",
    users: "用户管理",
    devices: "设备管理",
    tunnels: "Tunnel 与域名",
    domains: "域名记录",
    subscriptions: "订阅与权益",
    orders: "订单",
    payments: "支付记录",
    "issue-reports": "问题反馈",
    "system-config": "系统配置",
    audit: "审计日志"
  })[tab];
}

createRoot(document.getElementById("root")!).render(<AdminApp />);
