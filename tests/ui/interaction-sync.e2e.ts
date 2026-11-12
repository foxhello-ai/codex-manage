import { expect, test } from "@playwright/test";
import type { ApprovalSummary } from "../../src/shared/models";
import { installUiHarness, sessionId } from "./fixtures";

const question: ApprovalSummary = {
  id: "question-1", requestId: "input-1", threadId: sessionId, turnId: "live-turn", itemId: "input-item",
  kind: "tool_user_input", status: "pending", title: "需要补充输入", command: null, cwd: null,
  reason: "请选择本轮需要审核的界面。", createdAt: "2026-11-12T01:00:00Z", resolvedAt: null, raw: {},
  questions: [{ id: "screen", header: "审核界面", question: "选择现有方案或填写其他界面。", isOther: true, isSecret: false,
    options: [{ label: "V3", description: "查看第三版界面" }, { label: "TRY-02", description: "查看第二次尝试" }] }]
};

test("a Web approval opened before its delayed snapshot appears without repeated clicks", async ({ page }) => {
  const approval: ApprovalSummary = { ...question, id: "delayed-web-approval", requestId: 42,
    kind: "command_execution", title: "允许运行项目检查？", command: "npm run typecheck", questions: [] };
  const h = await installUiHarness(page, { status: "waiting_approval", runtimeSequence: 11, runtimeApprovals: false, snapshotOnConnect: false });
  await page.goto(`/${sessionId}`);
  await expect.poll(() => h.calls.filter(call => call.path.endsWith("/runtime")).length).toBeGreaterThan(0);
  await expect.poll(h.socketCount).toBe(1);
  await page.locator(".approvalTrigger").click();
  await expect(page.getByRole("dialog", { name: "待审批", exact: true }).getByRole("status")).toContainText("正在加载审批请求");
  h.sendSnapshot(10, [approval]);
  const sheet = page.getByRole("dialog", { name: approval.title });
  await expect(sheet.getByText("npm run typecheck", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "仅允许这一次", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(h.calls.filter(call => call.path.includes("/approvals/"))).toHaveLength(1);
  expect(h.calls.find(call => call.path.includes("/approvals/"))?.body).toMatchObject({ decision: "accept" });
  h.sendSnapshot(10, [approval]);
  await expect(sheet).toBeHidden();
  expect(h.pageErrors).toEqual([]);
});

test("HTTP runtime arriving before an older WS snapshot does not hide the question", async ({ page }, info) => {
  const h = await installUiHarness(page, { status: "waiting_user", runtimeSequence: 11, runtimeApprovals: false, snapshotOnConnect: false });
  await page.goto(`/${sessionId}`);
  await expect.poll(() => h.calls.filter(call => call.path.endsWith("/runtime")).length).toBeGreaterThan(0);
  await expect.poll(h.socketCount).toBe(1);
  h.sendSnapshot(10, [question]);
  const sheet = page.getByRole("dialog", { name: question.title });
  await expect(sheet.getByText("查看第三版界面", { exact: false })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "拒绝此操作" })).toHaveCount(0);
  await expect(page.locator(".composerStatus")).toContainText("等待你回答");
  await page.screenshot({ path: `docs/acceptance/2026-11-12-desktop-interaction-sync/${info.project.name}-question.png` });
  await sheet.getByRole("button", { name: "提交回答", exact: true }).click();
  expect(h.calls.filter(call => call.path.includes("/approvals/"))).toHaveLength(0);
  await sheet.getByLabel("审核界面（必填）").selectOption({ label: "自行填写" });
  await sheet.getByLabel("审核界面：自定义回答").fill("42号项目 V3");
  await sheet.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(h.calls.find(call => call.path.includes("/approvals/"))?.body).toMatchObject({ decision: "accept", answers: { screen: ["42号项目 V3"] } });
  h.sendSnapshot(10, [question]);
  await expect(sheet).toBeHidden();
  expect(h.pageErrors).toEqual([]);
});

test("history loads one recent page and retrieves older pages only after local history is revealed", async ({ page }) => {
  const h = await installUiHarness(page, { managed: true });
  const base = h.getDetail(sessionId);
  const turns = Array.from({ length: 28 }, (_, index) => ({ ...base.turns[0], id: `paged-${index}`, startedAt: "", items: [
    { id: `paged-user-${index}`, type: "user_message" as const, text: `历史问题 ${index}` },
    { id: `paged-agent-${index}`, type: "agent_message" as const, phase: "final_answer", text: `历史回答 ${index}` }
  ] }));
  const pages: string[] = [];
  await page.route(`**/api/sessions/${sessionId}?**`, async route => {
    const query = new URL(route.request().url()).searchParams;
    const older = query.get("turnCursor") === "older-page";
    if (query.get("turns") === "false") return route.fulfill({ json: { session: { ...base, turns: [] } } });
    pages.push(older ? "older" : "recent");
    expect(query.get("turnLimit")).toBe("20");
    return route.fulfill({ json: { session: { ...base, turns: older ? turns.slice(0, 8) : turns.slice(8), historyPage: { nextCursor: older ? null : "older-page", version: null, unchanged: false } } } });
  });
  await page.goto(`/${sessionId}`);
  await expect(page.locator(".turnBlock")).toHaveCount(5);
  for (const count of [10, 15, 20]) {
    await page.getByRole("button", { name: /加载更早/ }).click();
    await expect(page.locator(".turnBlock")).toHaveCount(count);
  }
  expect(pages).toEqual(["recent"]);
  await page.getByRole("button", { name: "读取更早消息", exact: true }).click();
  await expect(page.locator(".turnBlock")).toHaveCount(25);
  await page.getByRole("button", { name: /加载更早/ }).click();
  await expect(page.locator(".turnBlock")).toHaveCount(28);
  expect(pages).toEqual(["recent", "older"]);
  h.emit("turn_completed", { turn: { id: "paged-27" } });
  await expect.poll(() => pages.filter(page => page === "recent").length).toBeGreaterThan(1);
  await expect(page.locator(".turnBlock")).toHaveCount(28);
  await expect(page.getByText("历史问题 0", { exact: true })).toBeAttached();
  expect(h.pageErrors).toEqual([]);
});

test("HTTP recovers pending questions without WS; closing preserves them and refresh restores them", async ({ page }) => {
  const h = await installUiHarness(page, { status: "waiting_user", approvals: [question], snapshotOnConnect: false });
  await page.goto(`/${sessionId}`);
  let sheet = page.getByRole("dialog", { name: question.title });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "稍后回答", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(h.calls.filter(call => call.path.includes("/approvals/"))).toHaveLength(0);
  await page.locator(".approvalTrigger").click();
  await expect(sheet).toBeVisible();
  await page.reload();
  sheet = page.getByRole("dialog", { name: question.title });
  await expect(sheet).toBeVisible();
  h.emit("approval_resolved", { approval: { ...question, status: "resolved" } });
  await expect(sheet).toBeHidden();
  h.setApprovals([]);
  h.disconnect();
  await expect.poll(h.socketCount).toBe(1);
  h.sendSnapshot(10, [question]);
  await expect(sheet).toBeHidden();
  expect(h.pageErrors).toEqual([]);
});

test("MCP forms send typed controls and cancellation has its own API action", async ({ page }) => {
  const form: ApprovalSummary = { ...question, id: "mcp-1", kind: "mcp_elicitation", interactionMode: "form", questions: [
    { id: "count", header: "数量", question: "输入 1 到 5", isOther: false, isSecret: false, options: null, inputType: "integer", minimum: 1, maximum: 5 },
    { id: "enabled", header: "启用", question: "", isOther: false, isSecret: false, options: null, inputType: "boolean" }
  ] };
  const h = await installUiHarness(page, { status: "waiting_user", approvals: [form] });
  await page.goto(`/${sessionId}`);
  const sheet = page.getByRole("dialog", { name: question.title });
  await sheet.getByLabel("数量（必填）").fill("3");
  await sheet.getByLabel("启用（必填）").selectOption("false");
  await sheet.getByRole("button", { name: "取消请求", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(h.calls.find(call => call.path.includes("/approvals/"))?.body).toEqual({ decision: "cancel" });
  expect(h.pageErrors).toEqual([]);
});


test("desktop async questions open once, accept custom text and clear without the next-turn queue", async ({ page }, info) => {
  const h = await installUiHarness(page, { externalQueue: true });
  const id = JSON.stringify(["request_user_input_async", "call_async_ui", 0]);
  let submitted = false;
  const posts: unknown[] = [];
  await page.route("**/api/sessions/*/desktop-questions", async route => {
    if (route.request().method() === "POST") { posts.push(route.request().postDataJSON()); submitted = true; }
    await route.fulfill({ json: { available: true, turnId: "desktop-live-turn", questions: submitted ? [] : [{ id, title: "请确认是否按当前售后界面继续验收？", options: ["认可当前视觉基准，继续复验", "保留旧正式设计，按旧设计调整"] }], submissions: submitted ? [{ questionId: id, status: "accepted" }] : [] } });
  });
  await page.goto(`/${sessionId}`);
  const sheet = page.getByRole("dialog", { name: "桌面提问", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "稍后回答", exact: true }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("region", { name: "桌面途中提问" }).getByRole("button").click();
  await sheet.getByRole("button", { name: "提交回答", exact: true }).click();
  expect(posts).toHaveLength(0);
  await sheet.getByLabel("你的回答（必填）").selectOption({ label: "自行填写" });
  await sheet.getByLabel("你的回答：自定义回答").fill("认可售后行和查询弹窗，按当前视觉基准继续验收。");
  await page.screenshot({ path: `docs/acceptance/2026-11-12-desktop-interaction-sync/${info.project.name}-desktop-async-question.png` });
  await sheet.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(posts).toEqual([{ turnId: "desktop-live-turn", questionId: id, answer: "认可售后行和查询弹窗，按当前视觉基准继续验收。" }]);
  await expect(page.getByText("回答已提交给桌面当前任务。", { exact: true })).toBeVisible();
  expect(h.calls.filter(call => call.path.endsWith("/input"))).toHaveLength(0);
  expect(h.pageErrors).toEqual([]);
});

test("uncertain desktop question submission never offers a duplicate send", async ({ page }) => {
  await installUiHarness(page, { externalQueue: true });
  const id = JSON.stringify(["request_user_input_async", "call_uncertain_ui", 0]);
  let submitted = false, posts = 0;
  await page.route("**/api/sessions/*/desktop-questions", async route => {
    if (route.request().method() === "POST") { submitted = true; posts++; }
    await route.fulfill({ json: { available: true, turnId: "turn-uncertain", questions: [{ id, title: "请选择需要复验的界面", options: ["界面 A", "界面 B"] }], submissions: submitted ? [{ questionId: id, status: "unknown" }] : [] } });
  });
  await page.goto(`/${sessionId}`);
  const sheet = page.getByRole("dialog", { name: "桌面提问", exact: true });
  await sheet.getByLabel("你的回答（必填）").selectOption("界面 A");
  await sheet.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("回答结果待桌面确认，请勿重复提交。可到桌面核对。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("region", { name: "桌面途中提问" }).getByRole("button")).toHaveCount(0);
  expect(posts).toBe(1);
});
