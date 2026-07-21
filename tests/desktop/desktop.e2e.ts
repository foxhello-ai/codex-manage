import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;

test("packaged desktop application launches its embedded local service", async () => {
  const packagedExecutable = process.env.CODEX_PACKAGED_APP_PATH;
  test.skip(!packagedExecutable, "CODEX_PACKAGED_APP_PATH is not configured");
  const userDataDir = await mkdtemp(join(tmpdir(), "codex-manage-packaged-e2e-"));
  const application = await electron.launch({
    executablePath: packagedExecutable!,
    env: {
      ...process.env,
      CODEX_DESKTOP_USER_DATA_DIR: userDataDir,
      CODEX_CONTROL_API_URL: "http://127.0.0.1:9"
    }
  });

  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "从手机安全访问本机 Codex" })).toBeVisible();
    await expect(window.getByText("运行中", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("heading", { name: "设置本机访问密码" })).toBeVisible();
  } finally {
    await application.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("desktop starts the local service and completes first-run password setup", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "codex-manage-electron-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve(root, "apps/desktop")],
    env: {
      ...process.env,
      CODEX_DESKTOP_USER_DATA_DIR: userDataDir,
      CODEX_CLOUDFLARED_PATH: process.env.CODEX_CLOUDFLARED_PATH ?? "/usr/local/bin/cloudflared",
      CODEX_CONTROL_API_URL: "http://127.0.0.1:9"
    }
  });

  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "从手机安全访问本机 Codex" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "设置本机访问密码" })).toBeVisible();
    await expect(window.getByText("运行中", { exact: true })).toBeVisible({ timeout: 30_000 });

    await window.getByLabel("访问密码").fill("desktop-e2e-password");
    await window.getByLabel("确认密码").fill("desktop-e2e-password");
    await window.getByRole("button", { name: "保存密码" }).click();

    const errorBanner = window.locator(".errorBanner");
    await window.waitForTimeout(500);
    if (await errorBanner.isVisible()) {
      throw new Error(`Desktop setup failed: ${await errorBanner.textContent()}`);
    }

    await expect(window.getByRole("heading", { name: "设置本机访问密码" })).toBeHidden();
    await expect(window.getByRole("heading", { name: "登录设备管理平台" })).toBeVisible();
    await expect(window.getByText("运行中", { exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("desktop logs into the control plane and creates a Quick Tunnel pairing QR", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "codex-manage-electron-tunnel-e2e-"));
  const fixtureDir = await mkdtemp(join(tmpdir(), "codex-manage-cloudflared-e2e-"));
  const fakeCloudflared = join(fixtureDir, "cloudflared");
  await writeFile(fakeCloudflared, `#!/bin/sh
echo '{"message":"Quick Tunnel ready at https://desktop-e2e.trycloudflare.com"}' 1>&2
trap 'exit 0' TERM INT
while true; do sleep 1; done
`);
  await chmod(fakeCloudflared, 0o755);
  const mockControl = await startMockControlApi();
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve(root, "apps/desktop")],
    env: {
      ...process.env,
      CODEX_DESKTOP_USER_DATA_DIR: userDataDir,
      CODEX_CLOUDFLARED_PATH: fakeCloudflared,
      CODEX_CONTROL_API_URL: mockControl.url
    }
  });

  try {
    const window = await application.firstWindow();
    await expect(window.getByText("运行中", { exact: true })).toBeVisible({ timeout: 30_000 });
    await window.getByLabel("访问密码").fill("desktop-e2e-password");
    await window.getByLabel("确认密码").fill("desktop-e2e-password");
    await window.getByRole("button", { name: "保存密码" }).click();
    await expect(window.getByRole("heading", { name: "登录设备管理平台" })).toBeVisible();

    await window.getByLabel("邮箱或手机号").fill("owner@example.com");
    await window.getByLabel("密码", { exact: true }).fill("account-password");
    await window.getByRole("button", { name: "登录平台" }).click();
    await expect(window.getByRole("heading", { name: "owner@example.com" })).toBeVisible();

    await window.getByRole("button", { name: "启动远程通道" }).click();
    await expect(window.getByText("https://desktop-e2e.trycloudflare.com", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "生成扫码二维码" }).click();
    await expect(window.getByRole("heading", { name: "使用手机扫码访问" })).toBeVisible();
    await expect(window.getByAltText("手机扫码访问二维码")).toBeVisible();
  } finally {
    await application.close();
    await mockControl.close();
    await Promise.all([
      rm(userDataDir, { recursive: true, force: true }),
      rm(fixtureDir, { recursive: true, force: true })
    ]);
  }
});

async function startMockControlApi(): Promise<{ url: string; close: () => Promise<void> }> {
  const deviceId = "019f829c-e97e-7be3-82fa-7968ca730301";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const now = Date.now();
    const future = new Date(now + 60 * 60 * 1000).toISOString();
    const refreshFuture = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const path = request.url ?? "";

    if (path === "/v1/auth/login") return sendJson(response, {
      user: { id: "019f829c-e97e-7be3-82fa-7968ca730302", identityType: "email", identifier: "owner@example.com" },
      accessToken: "cm_access_test",
      refreshToken: "cm_refresh_test",
      accessExpiresAt: future,
      refreshExpiresAt: refreshFuture
    });
    if (path === "/v1/devices") return sendJson(response, { device: { id: deviceId }, credential: "cm_device_test" });
    if (path === "/v1/devices/credential/exchange") return sendJson(response, { accessToken: "cm_device_access_test", expiresAt: future, device: { id: deviceId } });
    if (path === "/v1/entitlements") return sendJson(response, { entitlements: { "tunnel.quick": true, "tunnel.named": false, "device.max_count": 1 } });
    if (path === "/v1/subscriptions/current") return sendJson(response, {
      subscription: { plan_code: "free", plan_name: "体验版", expires_at: null }
    });
    if (path === `/v1/devices/${deviceId}/tunnel-config`) return sendJson(response, { mode: "quick", hostname: null, token: null, namedTunnelStatus: null });
    if (path === `/v1/devices/${deviceId}/heartbeat`) return sendJson(response, { accepted: true, serverTime: new Date().toISOString() });
    if (path === "/v1/auth/logout") return sendJson(response, { loggedOut: true });
    response.statusCode = 404;
    return sendJson(response, { error: { message: `mock route not found: ${path}` } });
  });
  await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not expose a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}

function sendJson(response: import("node:http").ServerResponse, body: unknown) {
  response.end(JSON.stringify(body));
}
