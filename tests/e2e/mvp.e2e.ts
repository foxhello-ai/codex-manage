import { expect, test, type Page, type TestInfo } from "@playwright/test";

const password = process.env.CODEX_E2E_PASSWORD ?? "fmzh2026";
const acceptanceDir = "docs/acceptance/2026-07-15";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会话管理" })).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: `${acceptanceDir}/${testInfo.project.name}-${name}.png`,
    fullPage: true
  });
}

test("login, invalid password, and logout form a closed flow", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "登录管理台" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await screenshot(page, testInfo, "login");

  await page.getByLabel("密码").fill("wrong-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("密码错误")).toBeVisible();

  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会话管理" })).toBeVisible();

  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByRole("heading", { name: "登录管理台" })).toBeVisible();
});

test("session list, detail deep link, websocket, and settings are usable", async ({ page }, testInfo) => {
  await login(page);
  await expect(page.getByRole("button", { name: /删除/ })).toHaveCount(0);
  await expect(page.getByText("codex-cli 0.144.3")).toBeVisible();
  await expect(page.getByText("ready / initialized")).toBeVisible();

  if (testInfo.project.name === "mobile") {
    await expect(page.locator(".desktopSessionPanel")).toBeHidden();
    await page.getByRole("button", { name: "打开会话列表" }).click();
    const drawer = page.getByRole("dialog", { name: "会话列表" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "会话列表" })).toHaveCount(1);
    await expect(drawer.getByLabel("搜索会话")).toBeVisible();

    const firstSessionId = await drawer.locator(".sessionId").first().getAttribute("title");
    expect(firstSessionId).toBeTruthy();
    await drawer.getByLabel("搜索会话").fill(firstSessionId!.slice(0, 8));
    await drawer.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(drawer.locator(".sessionId").first()).toHaveAttribute("title", firstSessionId!);
    await screenshot(page, testInfo, "session-drawer");
    await drawer.getByLabel("搜索会话").fill("");
    await drawer.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "进入" }).nth(1)).toBeVisible();
    await drawer.getByRole("button", { name: "进入" }).nth(1).click();
    await expect(drawer).toBeHidden();
  } else {
    await expect(page.locator(".desktopSessionPanel")).toBeVisible();
    await screenshot(page, testInfo, "session-list");
    await page.locator(".desktopSessionPanel").getByRole("button", { name: "进入" }).nth(1).click();
  }

  await expect(page).not.toHaveURL(/\/$/);
  await expect(page.locator(".sessionHero h3")).toBeVisible();
  const runtimePanel = page.getByRole("region", { name: "运行状态", exact: true });
  await expect(runtimePanel).toBeVisible();
  await expect(page.getByText("正在加载详情...", { exact: true })).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("正在加载历史命令...", { exact: true })).toBeHidden({ timeout: 30_000 });

  if (testInfo.project.name === "mobile") {
    const mobileRuntime = page.getByRole("region", { name: "移动运行状态" });
    await expect(mobileRuntime).toBeVisible();
    await expect(mobileRuntime.getByText("实时已连接")).toBeVisible();
    await expect(mobileRuntime.getByRole("button", { name: "展开运行状态" })).toBeVisible();
    await mobileRuntime.getByRole("button", { name: "展开运行状态" }).click();
    await expect(mobileRuntime.getByText("权限：需审批")).toBeVisible();
    await screenshot(page, testInfo, "runtime-expanded");
    await mobileRuntime.getByRole("button", { name: "收起运行状态" }).click();
  } else {
    const floatingRuntime = page.getByRole("complementary", { name: "浮动运行状态" });
    await expect(floatingRuntime).toBeVisible();
    await expect(floatingRuntime.getByText("实时已连接")).toBeVisible();
  }
  await screenshot(page, testInfo, "session-detail");

  const detailUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.locator(".sessionHero h3")).toBeVisible();

  await page.getByRole("button", { name: "打开设置和诊断" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "设置和诊断" })).toBeVisible();
  await expect(page.getByRole("region", { name: "系统健康状态" })).toContainText("运行正常");
  await expect(page.getByText("codex-cli 0.144.3")).toBeVisible();
  await expect(page.getByText(/\.codex\/sessions/)).toBeVisible();
  await screenshot(page, testInfo, "settings");
});

test("approval actions render and resolve without mobile overlap", async ({ page }, testInfo) => {
  await login(page);
  const sessionsResponse = await page.request.get("/api/sessions");
  const sessions = (await sessionsResponse.json()).sessions as Array<{ id: string }>;
  const target = sessions[1];
  expect(target).toBeTruthy();

  const runtime = {
    threadId: target.id,
    status: "waiting_approval",
    permissionMode: "default",
    activeTurnId: "turn-m12",
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z",
    lastError: null,
    pendingApprovalCount: 1,
    eventSeq: 1
  };
  const approval = {
    id: "approval-m12",
    requestId: 99,
    threadId: target.id,
    turnId: "turn-m12",
    itemId: "item-m12",
    kind: "command_execution",
    status: "pending",
    title: "命令执行审批",
    command: "npm test",
    cwd: "/config/projects/codex-manage",
    reason: "M12 审批界面验收",
    questions: [],
    raw: {},
    createdAt: "2026-07-15T00:00:01.000Z",
    resolvedAt: null
  };

  await page.routeWebSocket(/\/api\/sessions\/.*\/ws/, (socket) => {
    setTimeout(() => {
      socket.send(JSON.stringify({
        seq: 4,
        threadId: target.id,
        type: "snapshot",
        payload: {
          runtime: { ...runtime, eventSeq: 4 },
          approvals: [approval],
          events: [
            {
              seq: 2,
              threadId: target.id,
              type: "agent_message_delta",
              payload: { turnId: "turn-m12", itemId: "message-m12", delta: "M12 实时回复" },
              createdAt: "2026-07-15T00:00:01.100Z"
            },
            {
              seq: 3,
              threadId: target.id,
              type: "command_started",
              payload: { turnId: "turn-m12", itemId: "command-m12", command: "npm test", cwd: "/config/projects/codex-manage", status: "running" },
              createdAt: "2026-07-15T00:00:01.200Z"
            },
            {
              seq: 4,
              threadId: target.id,
              type: "command_output_delta",
              payload: { turnId: "turn-m12", itemId: "command-m12", delta: "M12 tests running" },
              createdAt: "2026-07-15T00:00:01.300Z"
            }
          ]
        },
        createdAt: "2026-07-15T00:00:01.000Z"
      }));
    }, 300);
  });
  await page.route(/\/api\/sessions\/.*\/approvals\/approval-m12$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        approval: { ...approval, status: "declined", resolvedAt: "2026-07-15T00:00:02.000Z" },
        runtime: { ...runtime, status: "waiting_input", pendingApprovalCount: 0, eventSeq: 2 }
      })
    });
  });

  await page.goto(`/${encodeURIComponent(target.id)}`);
  const approvalPanel = page.getByRole("region", { name: "审批请求" });
  await expect(approvalPanel).toBeVisible();
  await expect(approvalPanel.getByText("npm test", { exact: true })).toBeVisible();
  await expect(approvalPanel.getByRole("button", { name: "允许一次" })).toBeVisible();
  await expect(approvalPanel.getByRole("button", { name: "本会话允许" })).toBeVisible();
  await expect(approvalPanel.getByRole("button", { name: "拒绝", exact: true })).toBeVisible();
  await expect(approvalPanel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect(page.getByText("M12 实时回复", { exact: true })).toBeVisible();
  await expect(page.getByText("M12 tests running", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("region", { name: "移动运行状态" })).toContainText("待审批 1");
  }
  await screenshot(page, testInfo, "approval");

  await approvalPanel.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(approvalPanel).toBeHidden();
});
