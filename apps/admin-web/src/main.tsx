import { FormEvent, ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveApiBase } from "./apiBase";
import "./styles.css";

type Tab = "overview" | "users" | "devices" | "tunnels" | "domains" | "billing-plans" | "subscriptions" | "orders" | "payments" | "payment-callbacks" | "issue-reports" | "audit";
type JsonRecord = Record<string, unknown>;

const apiBase = resolveApiBase(
  import.meta.env.VITE_CONTROL_API_URL,
  window.location,
  import.meta.env.VITE_CONTROL_API_PORT ?? "4320"
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
      const path = adminPath(nextTab);
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
          {(["overview", "users", "devices", "tunnels", "domains", "billing-plans", "subscriptions", "orders", "payments", "payment-callbacks", "issue-reports", "audit"] as Tab[]).map((item) => (
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
            {tab !== "overview" ? <input aria-label="搜索当前列表" placeholder="搜索当前列表" value={search} onChange={(event) => setSearch(event.target.value)} /> : null}
            <button onClick={() => void load(tab)}>刷新</button>
          </div>
        </header>
        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="empty">正在载入…</div> : tab === "overview" ? (
          <Overview data={(data ?? {}) as JsonRecord} />
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

function DataTable({ rows, token, onChanged, tab }: { rows: JsonRecord[]; token: string; onChanged: () => void; tab: Tab }) {
  if (!rows.length) return <div className="empty">暂无数据</div>;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 10);
  return (
    <div className="tableWrap">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}{["users", "devices", "tunnels", "issue-reports", "billing-plans", "orders"].includes(tab) ? <th>操作</th> : null}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={String(row.id ?? index)}>
            {columns.map((column) => <td key={column}>{formatValue(row[column])}</td>)}
            {tab === "users" ? <td className="rowActions"><GrantButton userId={String(row.id)} token={token} onChanged={onChanged} /><StatusButton kind="users" id={String(row.id)} current={String(row.status)} token={token} onChanged={onChanged} /></td> : null}
            {tab === "devices" ? <td><StatusButton kind="devices" id={String(row.id)} current={String(row.status)} token={token} onChanged={onChanged} /></td> : null}
            {tab === "tunnels" ? <td><RebuildTunnelButton id={String(row.id)} mode={String(row.mode)} token={token} onChanged={onChanged} /></td> : null}
            {tab === "billing-plans" ? <td><PlanEditButton row={row} token={token} onChanged={onChanged} /></td> : null}
            {tab === "orders" ? <td><RefundReserveButton row={row} token={token} onChanged={onChanged} /></td> : null}
            {tab === "issue-reports" ? <td><IssueReportActions id={String(row.id)} status={String(row.status)} token={token} onChanged={onChanged} /></td> : null}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PlanEditButton({ row, token, onChanged }: { row: JsonRecord; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function edit() {
    const price = window.prompt("请输入价格，单位：分", String(row.price_cents ?? 0));
    if (price === null) return;
    const duration = window.prompt("请输入有效天数，月付 30 / 年付 365", row.duration_days === null || row.duration_days === undefined ? "" : String(row.duration_days));
    if (duration === null) return;
    const enabled = window.confirm("是否开启购买？确定=开启，取消=关闭");
    const features = window.prompt("请输入权益 JSON", JSON.stringify(row.features ?? {}, null, 2));
    if (features === null) return;
    setBusy(true);
    try {
      await request(`/v1/admin/billing/plans/${encodeURIComponent(String(row.id))}`, {
        method: "PATCH",
        body: JSON.stringify({
          priceCents: Number.parseInt(price, 10),
          durationDays: duration.trim() ? Number.parseInt(duration, 10) : null,
          purchaseEnabled: enabled,
          features: JSON.parse(features) as Record<string, unknown>
        })
      }, token);
      onChanged();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return <button className="small" disabled={busy} onClick={() => void edit()}>配置套餐</button>;
}

function RefundReserveButton({ row, token, onChanged }: { row: JsonRecord; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function reserve() {
    if (String(row.status) !== "paid") {
      window.alert("只有已支付订单可以记录退款预留。");
      return;
    }
    const reason = window.prompt("请输入退款处理原因", "客户申请退款");
    if (!reason) return;
    if (!window.confirm("首版只记录退款预留，不会自动调用支付平台退款。确认记录？")) return;
    setBusy(true);
    try {
      await request(`/v1/admin/billing/orders/${encodeURIComponent(String(row.id))}/refund`, {
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
  return <button className="small" disabled={busy || String(row.status) !== "paid"} onClick={() => void reserve()}>退款预留</button>;
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
  const key = tab === "audit"
    ? "auditLogs"
    : tab === "issue-reports"
      ? "issueReports"
      : tab === "billing-plans"
        ? "plans"
        : tab === "payment-callbacks"
          ? "callbacks"
          : tab;
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as JsonRecord[] : [];
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
    "billing-plans": "套餐配置",
    subscriptions: "订阅与权益",
    orders: "订单",
    payments: "支付记录",
    "payment-callbacks": "支付回调",
    "issue-reports": "问题反馈",
    audit: "审计日志"
  })[tab];
}

function adminPath(tab: Tab): string {
  if (tab === "overview") return "/v1/admin/overview";
  if (tab === "audit") return "/v1/admin/audit-logs";
  if (tab === "billing-plans") return "/v1/admin/billing/plans";
  if (tab === "payment-callbacks") return "/v1/admin/billing/callbacks";
  return `/v1/admin/${tab}`;
}

createRoot(document.getElementById("root")!).render(<AdminApp />);
