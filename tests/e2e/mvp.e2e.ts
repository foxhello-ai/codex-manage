import { expect, test, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";
import type { RuntimeSnapshot, SessionModelState, SessionStatus } from "../../src/shared/models";

const password = process.env.CODEX_E2E_PASSWORD ?? "fmzh2026";
const acceptanceDir = "docs/acceptance/2026-07-15";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

function modelState(patch: Partial<SessionModelState> = {}): SessionModelState {
  return {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    updatedAt: null,
    actualModel: "legacy-model",
    actualModelProvider: "legacy-provider",
    actualReasoningEffort: "xhigh",
    actualModelSupported: false,
    applied: false,
    confirmationPending: false,
    lastError: null,
    ...patch
  };
}

function runtimeSnapshot(
  threadId: string,
  status: SessionStatus,
  selection: SessionModelState = modelState(),
  patch: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot {
  return {
    threadId,
    status,
    permissionMode: "default",
    activeTurnId: status === "running" || status === "waiting_approval" ? "turn-e2e" : null,
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:01.000Z",
    lastError: null,
    pendingApprovalCount: status === "waiting_approval" ? 1 : 0,
    eventSeq: 1,
    model: selection.actualModel,
    modelProvider: selection.actualModelProvider,
    reasoningEffort: selection.actualReasoningEffort,
    modelSelection: selection,
    modelChangeStatus: "idle",
    modelChangeError: null,
    ...patch
  };
}

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
  await expect(page.getByText(/codex-cli \d+\.\d+\.\d+/)).toBeVisible();
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
  await expect(page.getByText(/codex-cli \d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByText(/\.codex\/sessions/)).toBeVisible();
  await screenshot(page, testInfo, "settings");
});

test("approval actions render and resolve without mobile overlap", async ({ page }, testInfo) => {
  await login(page);
  const sessionsResponse = await page.request.get("/api/sessions");
  const sessions = (await sessionsResponse.json()).sessions as Array<{ id: string }>;
  const target = sessions[1];
  expect(target).toBeTruthy();

  const runtime = runtimeSnapshot(target.id, "waiting_approval", modelState({
    actualModel: "gpt-e2e",
    actualModelProvider: "test-provider",
    actualReasoningEffort: "high",
    actualModelSupported: true,
    applied: true
  }), {
    activeTurnId: "turn-m12",
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z"
  });
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

test("model selection, status restrictions, and explicit retry work on desktop and H5", async ({ page }, testInfo) => {
  await login(page);
  const sessionsResponse = await page.request.get("/api/sessions");
  const sessions = (await sessionsResponse.json()).sessions as Array<{ id: string }>;
  const target = sessions[1];
  expect(target).toBeTruthy();

  const legacySelection = modelState();
  let activeSelection = legacySelection;
  let activeStatus: SessionStatus = "history";
  let socket: WebSocketRoute | null = null;
  let eventSeq = 1;
  let inputRequests = 0;

  const frontierModel = {
    id: "frontier-v2",
    model: "frontier-v2",
    displayName: "Frontier V2",
    description: "用于复杂任务的前沿模型",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    upgradeModel: null,
    upgradeCopy: "推荐用于需要更强推理能力的会话"
  };
  const balancedModel = {
    id: "balanced-v1",
    model: "balanced-v1",
    displayName: "Balanced V1",
    description: "速度和质量平衡",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
    upgradeModel: null,
    upgradeCopy: null
  };

  await page.route(new RegExp(`/api/sessions/${target.id}$`), async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { session: Record<string, unknown> };
    body.session.modelState = legacySelection;
    await route.fulfill({ response, body: JSON.stringify(body), contentType: "application/json" });
  });
  await page.route(new RegExp(`/api/sessions/${target.id}/runtime$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runtime: runtimeSnapshot(target.id, activeStatus, activeSelection, { eventSeq }) })
    });
  });
  await page.route(/\/api\/models(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [frontierModel, balancedModel],
        loadedAt: "2026-07-19T00:00:00.000Z",
        stale: false,
        lastError: null
      })
    });
  });
  await page.route(new RegExp(`/api/sessions/${target.id}/model$`), async (route) => {
    const request = route.request().postDataJSON() as { mode: "follow_session" | "override"; model?: string; reasoningEffort?: string | null };
    if (request.mode === "override") {
      activeSelection = modelState({
        mode: "override",
        preferredModel: request.model ?? null,
        preferredReasoningEffort: request.reasoningEffort ?? null,
        updatedAt: "2026-07-19T00:00:02.000Z",
        actualModel: activeSelection.actualModel,
        actualModelProvider: activeSelection.actualModelProvider,
        actualReasoningEffort: activeSelection.actualReasoningEffort,
        actualModelSupported: activeSelection.actualModel === "legacy-model" ? false : true,
        applied: false
      });
    }
    const runtime = runtimeSnapshot(target.id, activeStatus, activeSelection, { eventSeq });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ selection: activeSelection, runtime, applied: false, confirmationPending: false })
    });
  });
  await page.route(new RegExp(`/api/sessions/${target.id}/input$`), async (route) => {
    inputRequests += 1;
    if (inputRequests > 1) {
      activeSelection = modelState({
        mode: "override",
        preferredModel: "balanced-v1",
        preferredReasoningEffort: "medium",
        updatedAt: "2026-07-19T00:00:05.000Z",
        actualModel: "balanced-v1",
        actualModelProvider: "test-provider",
        actualReasoningEffort: "medium",
        actualModelSupported: true,
        applied: true
      });
    }
    activeStatus = "running";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runtime: runtimeSnapshot(target.id, "running", activeSelection, { eventSeq }) })
    });
  });
  await page.routeWebSocket(new RegExp(`/api/sessions/${target.id}/ws`), (webSocket) => {
    socket = webSocket;
    setTimeout(() => {
      webSocket.send(JSON.stringify({
        seq: eventSeq,
        threadId: target.id,
        type: "snapshot",
        payload: {
          runtime: runtimeSnapshot(target.id, activeStatus, activeSelection, { eventSeq }),
          approvals: [],
          events: []
        },
        createdAt: "2026-07-19T00:00:01.000Z"
      }));
    }, 100);
  });

  function sendEvent(type: "session_status" | "error", payload: Record<string, unknown>) {
    if (!socket) throw new Error("WebSocket route is not connected");
    eventSeq += 1;
    socket.send(JSON.stringify({
      seq: eventSeq,
      threadId: target.id,
      type,
      payload,
      createdAt: `2026-07-19T00:00:${String(eventSeq).padStart(2, "0")}.000Z`
    }));
  }

  await page.goto(`/${encodeURIComponent(target.id)}`);
  const runtimePanel = page.getByRole("region", { name: "运行状态", exact: true });
  await expect(runtimePanel).toBeVisible();
  await expect(runtimePanel.getByText("当前会话模型，不在可选列表")).toBeVisible();
  await runtimePanel.getByRole("button", { name: "切换到支持模型" }).click();

  const selector = page.getByRole("dialog", { name: "切换会话模型" });
  await expect(selector).toBeVisible();
  await expect(selector.getByText(/legacy-model/)).toBeVisible();
  await selector.getByLabel("搜索模型").fill("Frontier");
  await expect(selector.getByRole("status")).toContainText("原推理强度 xhigh 不受支持");
  await selector.getByRole("option", { name: /Frontier V2/ }).click();
  await expect(selector.getByLabel("推理强度")).toHaveValue("high");

  if (testInfo.project.name === "mobile") {
    const box = await selector.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(Math.abs((box!.y + box!.height) - viewport!.height)).toBeLessThanOrEqual(2);
    expect(box!.height).toBeLessThanOrEqual(viewport!.height * 0.86);
    for (const buttonName of ["跟随会话", "应用模型"]) {
      const buttonBox = await selector.getByRole("button", { name: buttonName }).boundingBox();
      expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }

  await selector.getByRole("button", { name: "应用模型" }).click();
  await expect(selector).toBeHidden();
  await expect(runtimePanel.getByText("frontier-v2 · high", { exact: true })).toBeVisible();
  await expect(runtimePanel.getByText("已保存，将在恢复会话时应用。")).toBeVisible();

  activeStatus = "waiting_input";
  activeSelection = modelState({
    mode: "override",
    preferredModel: "frontier-v2",
    preferredReasoningEffort: "high",
    updatedAt: "2026-07-19T00:00:02.000Z",
    actualModel: "frontier-v2",
    actualModelProvider: "test-provider",
    actualReasoningEffort: "high",
    actualModelSupported: true,
    applied: true
  });
  sendEvent("session_status", { runtime: runtimeSnapshot(target.id, activeStatus, activeSelection, { eventSeq: eventSeq + 1 }) });
  await expect(runtimePanel.getByText("frontier-v2", { exact: true })).toBeVisible();

  activeStatus = "running";
  sendEvent("session_status", { runtime: runtimeSnapshot(target.id, activeStatus, activeSelection, { eventSeq: eventSeq + 1 }) });
  await expect(runtimePanel.getByRole("button", { name: "切换模型" })).toBeDisabled();
  await expect(runtimePanel.getByText("任务运行中，完成后可切换模型")).toBeVisible();

  activeStatus = "waiting_input";
  sendEvent("session_status", { runtime: runtimeSnapshot(target.id, activeStatus, activeSelection, { eventSeq: eventSeq + 1 }) });
  const retryText = "需要人工确认后重试的消息";
  await page.getByPlaceholder("输入继续任务内容").fill(retryText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => inputRequests).toBe(1);

  activeStatus = "failed";
  const failedRuntime = runtimeSnapshot(target.id, "failed", activeSelection, {
    eventSeq: eventSeq + 1,
    lastError: "upstream unavailable"
  });
  sendEvent("session_status", { runtime: failedRuntime });
  sendEvent("error", { turnId: "turn-e2e", willRetry: false, error: { message: "upstream unavailable" } });
  const errorCard = page.getByRole("alert").filter({ hasText: "upstream unavailable" });
  await expect(errorCard).toBeVisible();
  await errorCard.getByRole("button", { name: "选择其他模型" }).click();

  await expect(selector).toBeVisible();
  await selector.getByLabel("搜索模型").fill("Balanced");
  await selector.getByRole("option", { name: /Balanced V1/ }).click();
  await expect(selector.getByLabel("推理强度")).toHaveValue("medium");
  await selector.getByRole("button", { name: "应用模型" }).click();

  const retryDialog = page.getByRole("dialog", { name: "确认重试上一条消息" });
  await expect(retryDialog).toBeVisible();
  await expect(retryDialog.getByText(retryText, { exact: true })).toBeVisible();
  await expect(retryDialog.getByText("balanced-v1", { exact: true })).toBeVisible();
  expect(inputRequests).toBe(1);
  await retryDialog.getByRole("button", { name: "取消" }).click();
  await expect(retryDialog).toBeHidden();
  expect(inputRequests).toBe(1);

  await errorCard.getByRole("button", { name: "重试上一条消息" }).click();
  await expect(retryDialog).toBeVisible();
  await retryDialog.getByRole("button", { name: "使用当前模型重试" }).click();
  await expect.poll(() => inputRequests).toBe(2);
  await expect(retryDialog).toBeHidden();
});
