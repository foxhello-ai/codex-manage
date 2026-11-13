import { expect, test } from "@playwright/test";
import { installUiHarness, sessionId } from "./fixtures";

const timeoutError = { error: { code: "CODEX_APP_SERVER_UNAVAILABLE", message: "codex app-server request timed out: thread/turns/list" } };

test("a direct link shows metadata and a desktop question while history is still pending", async ({ page }) => {
  const h = await installUiHarness(page, { externalQueue: true });
  const base = h.getDetail(sessionId);
  let releaseHistory!: () => void;
  const pending = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route("**/api/sessions?**", route => route.fulfill({ json: { sessions: [] } }));
  await page.route(`**/api/sessions/${sessionId}?**`, async route => {
    if (new URL(route.request().url()).searchParams.get("turns") === "false") {
      return route.fulfill({ json: { session: { ...base, turns: [] } } });
    }
    await pending;
    await route.fulfill({ json: { session: base } });
  });
  await page.route("**/api/sessions/*/desktop-questions", route => route.fulfill({ json: {
    available: true, turnId: "desktop-live-turn", submissions: [],
    questions: [{ id: "question-loading", title: "历史加载期间仍可回答吗？", options: ["可以"] }]
  } }));
  try {
    await page.goto(`/${sessionId}`);
    await expect(page.getByText("正在加载最新历史消息...", { exact: true })).toBeVisible();
    const sheet = page.getByRole("dialog", { name: "桌面提问", exact: true });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "稍后回答" }).click();
    await expect(page.getByRole("textbox", { name: "发送给 Codex 的消息" })).toBeVisible();
  } finally { releaseHistory(); }
  await expect(page.locator(".turnBlock")).not.toHaveCount(0);
  expect(h.pageErrors).toEqual([]);
});

test("a first-load 503 stays visible during background retry and clears only after success", async ({ page }, info) => {
  const h = await installUiHarness(page, { externalQueue: true });
  const base = h.getDetail(sessionId);
  let reads = 0, releaseRetry!: () => void;
  const pending = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route(`**/api/sessions/${sessionId}?**`, async route => {
    if (new URL(route.request().url()).searchParams.get("turns") === "false") {
      return route.fulfill({ json: { session: { ...base, turns: [] } } });
    }
    if (++reads === 1) return route.fulfill({ status: 503, json: timeoutError });
    await pending;
    await route.fulfill({ json: { session: base } });
  });
  try {
    await page.goto(`/${sessionId}`);
    const error = page.getByRole("alert").filter({ hasText: "历史消息读取超时（503）" });
    await expect(error).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(error).toBeVisible();
    await expect(page.getByText("正在加载最新历史消息...", { exact: true })).toBeVisible();
    await page.screenshot({ path: `docs/acceptance/2026-11-13-history-503/${info.project.name}-persistent-error.jpg` });
  } finally { releaseRetry(); }
  await expect(page.getByRole("alert").filter({ hasText: "历史消息读取超时（503）" })).toBeHidden();
  await expect(page.locator(".turnBlock")).not.toHaveCount(0);
  expect(h.pageErrors).toEqual([]);
});

test("a failed refresh preserves loaded messages and manual retry requests the latest page", async ({ page }) => {
  const h = await installUiHarness(page, { managed: true });
  const base = h.getDetail(sessionId);
  let reads = 0, recover = false;
  await page.route(`**/api/sessions/${sessionId}?**`, route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("turns") === "false") return route.fulfill({ json: { session: { ...base, turns: [] } } });
    expect(query.has("turnCursor")).toBe(false);
    if (++reads > 1 && !recover) return route.fulfill({ status: 503, json: timeoutError });
    return route.fulfill({ json: { session: { ...base, historyPage: { nextCursor: "older-page", version: null, unchanged: false } } } });
  });
  await page.goto(`/${sessionId}`);
  await expect(page.locator(".turnBlock")).toHaveCount(5);
  h.emit("turn_completed", { turn: { id: "turn-11" } });
  const retry = page.getByRole("button", { name: "重新加载历史消息", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.locator(".turnBlock")).toHaveCount(5);
  recover = true;
  await retry.click();
  await expect(retry).toBeHidden();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
  expect(h.pageErrors).toEqual([]);
});
