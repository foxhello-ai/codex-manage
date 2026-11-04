import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { installUiHarness, longPath, sessionId } from "./fixtures";

const artifactDir = process.env.CODEX_UI_ARTIFACT_DIR ?? "docs/acceptance/2026-11-03-h5-ui-refinement";
const browser = (page: Page, _info: TestInfo) => page.locator(".sessionLibrary");
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  for (const surface of await page.locator(".historyContent, .taskInput, .mobileDashboardHome, .sheetBody").all()) {
    if (await surface.isVisible()) expect(await surface.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
}
async function touchTargets(locator: Locator) {
  for (const element of await locator.all()) {
    if (!await element.isVisible()) continue;
    const box = await element.boundingBox();
    expect(box?.width, await element.getAttribute("class") ?? "control width").toBeGreaterThanOrEqual(44);
    expect(box?.height, await element.getAttribute("class") ?? "control height").toBeGreaterThanOrEqual(44);
  }
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await noOverflow(page);
  await page.screenshot({ path: `${artifactDir}/${info.project.name}-${name}.png`, fullPage: false });
}
async function openDetail(page: Page) {
  await page.goto(`/${sessionId}`);
  await expect(page.locator(".timeline .turnBlock")).toHaveCount(5);
  await expect(page.getByLabel("发送给 Codex 的消息")).toBeVisible();
}

test("three list views, search, rename and ordinary directory selection", async ({ page }, info) => {
  const h = await installUiHarness(page);
  await page.goto("/");
  const list = browser(page, info);
  await expect(list.getByRole("tab", { name: "最近会话", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(list.locator(".sessionItem")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "打开会话列表", exact: true })).toHaveCount(0);
  await expect(page.locator(".workspaceWelcome, .workspaceSidebar")).toHaveCount(0);
  if (info.project.name.startsWith("landscape-")) await expect(list.locator(".sessionItem").first()).toBeInViewport({ ratio: 0.3 });
  await touchTargets(page.locator(".topbar button, .sessionLibraryHeading button, .sessionViewTabs button, .titleEditButton"));
  await screenshot(page, info, "sessions");
  await list.getByLabel("搜索会话").fill("已有会话 3");
  await list.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(list.locator(".sessionItem")).toHaveCount(1);
  await list.getByLabel("搜索会话").fill("");
  await list.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(list.locator(".sessionItem")).toHaveCount(10);
  await list.getByRole("button", { name: /编辑.*备注标题/ }).first().click();
  await list.locator(".titleEditInput").fill("手机端备注标题");
  await list.locator(".titleEditInput").press("Enter");
  await expect(list.getByRole("button", { name: "打开会话：手机端备注标题" })).toBeVisible();
  await list.getByRole("tab", { name: "按工作目录", exact: true }).click();
  await list.getByLabel("按工作目录筛选").selectOption(longPath);
  await expect(list.locator(".workspacePath code")).toHaveText(longPath);
  await screenshot(page, info, "directories");
  await list.getByRole("button", { name: "新建会话", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "选择工作目录", exact: true });
  await sheet.getByRole("combobox", { name: "工作目录", exact: true }).selectOption(longPath);
  await expect(sheet.locator(".workspacePath code")).toHaveText(longPath);
  await expect(sheet.getByRole("textbox")).toHaveCount(0);
  await touchTargets(sheet.locator("button, select"));
  await screenshot(page, info, "new-session");
  await sheet.getByRole("button", { name: "在此目录新建会话" }).click();
  await expect(page).toHaveURL(/\/new-session$/);
  expect(h.calls.find((call) => call.path === "/api/sessions" && call.method === "POST")?.body).toEqual({ cwd: longPath });
  if (info.project.name === "desktop") {
    const sidebar = page.locator(".workspaceSidebar");
    expect((await sidebar.boundingBox())!.width).toBe(280);
    const separator = page.getByRole("separator", { name: "调整会话列表宽度" });
    await separator.focus();
    await separator.press("ArrowRight");
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(296);
    await separator.dblclick();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(280);
    await page.getByRole("button", { name: "查看全部会话", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "打开会话列表", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "会话列表", exact: true })).toBeVisible();
    await screenshot(page, info, "conversation-drawer");
    await page.getByRole("button", { name: "返回完整会话列表", exact: true }).click();
  }
  await expect(page.locator(".sessionLibrary")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开会话列表", exact: true })).toHaveCount(0);
  expect(h.pageErrors).toEqual([]);
});

test("task grouping, pin, attach, and recent/history/manual task directories", async ({ page }, info) => {
  const h = await installUiHarness(page);
  await page.goto("/");
  const list = browser(page, info);
  await list.getByRole("tab", { name: "按任务", exact: true }).click();
  await list.getByRole("button", { name: "新建任务", exact: true }).click();
  let sheet = page.getByRole("dialog", { name: "新建任务", exact: true });
  await sheet.getByLabel("任务名称").fill("单独的会话分组");
  await sheet.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(sheet).toBeHidden();
  const card = list.locator(".taskCard").filter({ hasText: "手机端体验优化与现有会话分组" });
  await card.getByRole("button", { name: "置顶任务", exact: true }).click();
  await expect(card.getByRole("button", { name: "取消置顶", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "选择会话归入" }).click();
  sheet = page.getByRole("dialog", { name: "选择要归入的会话" });
  await sheet.getByRole("combobox", { name: "会话", exact: true }).selectOption("session-3");
  await sheet.getByRole("button", { name: "归入任务", exact: true }).click();
  await expect(sheet).toBeHidden();
  await screenshot(page, info, "tasks");
  await card.getByRole("button", { name: "选择会话打开" }).click();
  sheet = page.getByRole("dialog", { name: "选择要打开的会话" });
  await sheet.getByRole("combobox", { name: "会话", exact: true }).selectOption("session-1");
  await expect(sheet.locator(".workspacePath code")).toHaveText("/workspace/another-project");
  await sheet.getByRole("button", { name: "关闭面板" }).click();
  await card.getByRole("button", { name: "新建任务会话" }).click();
  sheet = page.getByRole("dialog", { name: "选择任务会话目录" });
  await expect(sheet.getByRole("radio", { name: /使用最近会话目录/ })).toBeChecked();
  await expect(sheet.locator(".workspacePath code")).toHaveText(longPath);
  await sheet.getByRole("radio", { name: /使用历史会话目录/ }).check();
  await expect(sheet.locator(".workspacePath code")).toHaveText("/workspace/another-project");
  await sheet.getByRole("radio", { name: /输入新的工作目录/ }).check();
  await sheet.getByRole("textbox").fill("/workspace/task-only-new-directory");
  await screenshot(page, info, "task-directory");
  await touchTargets(sheet.locator("button, .taskDirectoryOption"));
  await sheet.getByRole("button", { name: "创建任务会话", exact: true }).click();
  await expect(page).toHaveURL(/\/new-session$/);
  expect(h.calls.find((call) => call.path === "/api/tasks/task-ui/sessions" && call.method === "POST")?.body).toEqual({ cwd: "/workspace/task-only-new-directory" });
  expect(h.pageErrors).toEqual([]);
});

test("full replies, local code scrolling, process collapse and stable history reading", async ({ page }, info) => {
  const h = await installUiHarness(page);
  await openDetail(page);
  const history = page.locator(".historyContent");
  await expect(page.locator(".messageItem.agent .markdownContent").last()).toHaveCSS("font-size", "16px");
  const final = page.locator(".messageItem.agent").last();
  expect(await final.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
  await expect(final.getByText("最后一段仍然完整可读。", { exact: true })).toBeAttached();
  await expect(page.locator(".commentaryDetails[open]")).toHaveCount(0);
  await history.evaluate((node) => { node.scrollTop = 0; });
  await page.locator(".commentaryDetails summary").first().click();
  await expect(page.locator(".commentaryDetails[open]")).toHaveCount(1);
  const code = page.locator(".markdownCode pre").first();
  expect(await code.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await code.evaluate((node) => { node.scrollLeft = 200; });
  expect(await code.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await noOverflow(page);
  // Clicking a summary may scroll it into view on short landscape screens.
  // Capture the prepend anchor only after returning to the load-more position.
  await history.evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(() => history.evaluate((node) => node.scrollTop)).toBe(0);
  const firstTurn = page.locator(".turnBlock").first();
  const firstId = await firstTurn.locator(".messageItem.user").textContent();
  const before = await firstTurn.evaluate((node) => node.getBoundingClientRect().top);
  await page.getByRole("button", { name: /加载更早/ }).click();
  await expect(page.locator(".turnBlock")).toHaveCount(10);
  const anchor = page.locator(".turnBlock").nth(5);
  await expect(anchor.locator(".messageItem.user")).toHaveText(firstId);
  const after = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  const top = await history.evaluate((node) => node.scrollTop);
  h.emit("agent_message_delta", { turnId: "live-turn", itemId: "live-reply", delta: "新的实时回复，不应打断历史阅读。" });
  await expect(page.locator(".liveMessage.agent")).toBeAttached();
  expect(Math.abs(await history.evaluate((node) => node.scrollTop) - top)).toBeLessThanOrEqual(2);
  await screenshot(page, info, "history");
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await expect.poll(() => history.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
  h.emit("agent_message_delta", { turnId: "live-turn", itemId: "live-reply", delta: "\n\n" + "继续追加回复。".repeat(30) });
  await expect.poll(() => history.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
  await touchTargets(page.locator(".taskInputTools button, .timelineScrollButton, .commentaryDetails summary"));
  await screenshot(page, info, "conversation");
  expect(h.pageErrors).toEqual([]);
});

test("auto-growing input, attachment feedback, failed send retention, model and retry", async ({ page }, info) => {
  const h = await installUiHarness(page, { failInput: true });
  await openDetail(page);
  const input = page.getByLabel("发送给 Codex 的消息");
  await expect(input).toHaveCSS("font-size", "16px");
  const small = (await input.boundingBox())!.height;
  const text = "这是一段中文输入，用于检查多行自动增高。\n".repeat(12);
  await input.fill(text);
  const large = (await input.boundingBox())!.height;
  expect(large).toBeGreaterThan(small);
  expect(large).toBeLessThanOrEqual(132);
  expect(await input.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.locator('.taskInput input[type="file"]').setInputFiles([
    { name: "长文件名-".repeat(8) + ".txt", mimeType: "text/plain", buffer: Buffer.from("attachment") },
    { name: "fail.txt", mimeType: "text/plain", buffer: Buffer.from("failed attachment") }
  ]);
  await expect(page.getByText("正在上传附件…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await expect(page.locator(".taskAttachmentChip")).toHaveCount(1);
  await expect(page.getByRole("alert").filter({ hasText: "1 个附件上传失败" })).toBeVisible();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".liveErrorCard")).toBeVisible();
  expect(h.calls.filter((call) => call.path.endsWith("/input"))).toHaveLength(1);
  await expect(input).toHaveValue(text);
  await expect(page.locator(".taskAttachmentChip")).toHaveCount(1);
  await screenshot(page, info, "failed-send");
  await page.locator(".taskInput .composerModelButton").click();
  let sheet = page.getByRole("dialog", { name: "会话模型", exact: true });
  await sheet.getByRole("button", { name: /^模型 / }).click();
  await touchTargets(sheet.locator("button"));
  await screenshot(page, info, "models");
  await sheet.getByRole("option", { name: /另一个可用模型/ }).click();
  await expect(sheet).toBeHidden();
  expect(h.calls.find((call) => call.path.endsWith("/model"))?.body?.model).toBe("another-supported-model");
  // Existing failed-message flow offers retry after applying another model.
  await page.getByRole("dialog", { name: "确认重试上一条消息" }).getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".taskInput .composerPermissionButton").click();
  sheet = page.getByRole("dialog", { name: "启用完全权限", exact: true });
  await sheet.getByRole("button", { name: "取消", exact: true }).click();
  expect(h.calls.filter((call) => call.path.endsWith("/resume"))).toHaveLength(0);
  await page.locator(".taskInput .composerPermissionButton").click();
  await page.getByRole("dialog", { name: "启用完全权限" }).getByRole("button", { name: "确认启用" }).click();
  await expect(page.locator(".composerPermissionButton")).toHaveText("完全权限");
  await page.locator(".composerPermissionButton").click();
  await expect(page.locator(".composerPermissionButton")).toHaveText("需审批");
  await page.getByRole("button", { name: "重试上一条消息", exact: true }).click();
  sheet = page.getByRole("dialog", { name: "确认重试上一条消息" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "使用当前模型重试" }).click();
  await expect.poll(() => h.calls.filter((call) => call.path.endsWith("/input")).length).toBe(2);
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: /移除附件/ }).click();
  await expect(page.locator(".taskAttachmentChip")).toHaveCount(0);
  await expect(input).toHaveValue(text);
  expect(h.pageErrors).toEqual([]);
});

for (const [decision, label] of [["accept", "仅允许这一次"], ["acceptForSession", "本会话内允许"], ["decline", "拒绝此操作"], ["cancel", "取消请求"]] as const) {
  test(`approval ${decision} preserves its API meaning; closing submits nothing`, async ({ page }, info) => {
    const h = await installUiHarness(page, { status: "waiting_approval" });
    await openDetail(page);
    await expect(page.getByLabel("发送给 Codex 的消息")).toBeDisabled();
    await page.locator(".approvalTrigger").click();
    let sheet = page.getByRole("dialog", { name: "允许检查当前项目构建？" });
    await expect(sheet.locator(".workspacePath code")).toHaveText(longPath);
    const header = (await sheet.locator(".sheetHeader").boundingBox())!;
    await sheet.locator(".sheetBody").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    expect((await sheet.locator(".sheetHeader").boundingBox())!.y).toBe(header.y);
    await touchTargets(sheet.locator("button"));
    if (decision === "accept") await screenshot(page, info, "approval");
    await sheet.getByRole("button", { name: "关闭面板" }).click();
    expect(h.calls.filter((call) => call.path.includes("/approvals/"))).toHaveLength(0);
    await expect(page.locator(".approvalTrigger")).toBeVisible();
    await page.locator(".approvalTrigger").click();
    sheet = page.getByRole("dialog", { name: "允许检查当前项目构建？" });
    await sheet.getByRole("button", { name: label, exact: true }).click();
    await expect(sheet).toBeHidden();
    expect(h.calls.filter((call) => call.path.includes("/approvals/"))).toHaveLength(1);
    expect(h.calls.find((call) => call.path.includes("/approvals/"))?.body?.decision).toBe(decision);
    await expect(page.getByLabel("发送给 Codex 的消息")).toBeEnabled();
    expect(h.pageErrors).toEqual([]);
  });
}

test("live commands stay locally scrollable and sending keeps its disabled conditions", async ({ page }, info) => {
  const h = await installUiHarness(page, { status: "running" });
  await openDetail(page);
  await expect(page.locator(".composerModelButton")).toBeDisabled();
  await expect(page.locator(".composerPermissionButton")).toBeDisabled();
  await expect(page.getByLabel("发送给 Codex 的消息")).toBeEnabled();
  h.emit("command_started", { turnId: "live-turn", itemId: "cmd-live", command: "npm run " + "long-command-name".repeat(40), cwd: longPath, status: "running" });
  h.emit("command_output_delta", { turnId: "live-turn", itemId: "cmd-live", delta: "long-output-without-spaces".repeat(100) });
  await expect(page.locator(".commandCard")).toBeVisible();
  for (const area of await page.locator(".commandCard pre").all()) {
    expect(await area.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    await area.evaluate((node) => { node.scrollLeft = 200; });
    expect(await area.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  }
  await screenshot(page, info, "running");
  h.emit("command_completed", { turnId: "live-turn", itemId: "cmd-live", status: "completed", exitCode: 0 });
  await expect(page.locator(".commandCard")).toHaveCount(0);
  expect(h.pageErrors).toEqual([]);
});

test("visual viewport shrink, offset and restore keep composer and panels reachable", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "Mobile visual viewport simulation only");
  const h = await installUiHarness(page);
  await openDetail(page);
  const input = page.getByLabel("发送给 Codex 的消息");
  await input.fill("多行输入\n".repeat(8));
  await input.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 340 }, offsetTop: { configurable: true, value: 60 } });
    viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-height"))).toBe("340px");
  const send = (await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(400);
  expect(send.y).toBeGreaterThanOrEqual(60);
  const inputBox = (await input.boundingBox())!;
  expect(inputBox.y).toBeGreaterThanOrEqual(60);
  expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(send.y);
  await page.locator(".composerModelButton").click();
  const sheet = page.getByRole("dialog", { name: "会话模型", exact: true });
  const close = (await sheet.getByRole("button", { name: "关闭面板" }).boundingBox())!;
  expect(close.y).toBeGreaterThanOrEqual(60);
  const action = (await sheet.locator(".sheetActions button").boundingBox())!;
  expect(action.y + action.height).toBeLessThanOrEqual(400);
  await screenshot(page, info, "viewport-simulation");
  await sheet.getByRole("button", { name: "关闭面板" }).click();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    delete (viewport as unknown as Record<string, unknown>).height;
    delete (viewport as unknown as Record<string, unknown>).offsetTop;
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue("--app-height")))).toBeGreaterThan(340);
  await expect(input).toHaveValue("多行输入\n".repeat(8));
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(input).toHaveValue("多行输入\n".repeat(8));
  await expect.poll(async () => {
    const box = (await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox())!;
    return box.y + box.height;
  }).toBeLessThanOrEqual(390);
  await page.setViewportSize(originalViewport);
  await expect(input).toHaveValue("多行输入\n".repeat(8));
  await noOverflow(page);
  expect(h.pageErrors).toEqual([]);
});

test("successful send clears the draft and attachments without adding reply action bars", async ({ page }, info) => {
  const h = await installUiHarness(page);
  await openDetail(page);
  await page.getByLabel("发送给 Codex 的消息").fill("继续检查当前工作目录");
  await page.locator('.taskInput input[type="file"]').setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("context") });
  await expect(page.locator(".taskAttachmentChip")).toHaveCount(1);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByLabel("发送给 Codex 的消息")).toHaveValue("");
  await expect(page.locator(".taskAttachmentChip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  expect(h.calls.filter((call) => call.path.endsWith("/input"))).toHaveLength(1);
  expect(h.calls.find((call) => call.path.endsWith("/input"))?.body?.text).toContain("/.attachments/context.txt");
  await expect(page.locator(".messageItem.agent button")).toHaveCount(0);
  await noOverflow(page);
  expect(h.pageErrors).toEqual([]);
});

test("ordinary create failure stays in its panel and panel dismissal returns keyboard focus", async ({ page }, info) => {
  const h = await installUiHarness(page);
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 500, json: { error: { code: "CREATE_FAILED", message: "已有目录暂时不可用" } } });
  });
  await page.goto("/");
  const trigger = browser(page, info).getByRole("button", { name: "新建会话", exact: true });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "选择工作目录", exact: true });
  await sheet.getByRole("button", { name: "在此目录新建会话" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("已有目录暂时不可用");
  const close = sheet.getByRole("button", { name: "关闭面板" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.locator(".sheetActions button")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(h.pageErrors).toEqual([]);
});
