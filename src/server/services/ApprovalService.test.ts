import { describe, expect, it } from "vitest";
import { ApprovalService } from "./ApprovalService";
import { EventHub } from "./EventHub";

function createHarness() {
  const responses: Array<{ id: number | string; result: unknown }> = [];
  const pendingCounts: Array<{ threadId: string; count: number }> = [];
  const eventHub = new EventHub();
  const service = new ApprovalService(
    {
      respondToServerRequest(id, result) {
        responses.push({ id, result });
      }
    },
    eventHub,
    (threadId, count) => pendingCounts.push({ threadId, count })
  );

  return { service, eventHub, responses, pendingCounts };
}

describe("ApprovalService", () => {
  it("keeps a question pending when an approval-only decision or incomplete answer is submitted", () => {
    const { service, responses } = createHarness();
    service.handleServerRequest({ id: "ask-1", method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", questions: [{ id: "design", header: "UI方案", question: "请选择", options: [{ label: "A", description: "紧凑" }, { label: "B", description: "宽松" }] }]
    } });
    const pending = service.listPending("thread-1")[0];
    for (const decision of ["decline", "cancel", "acceptForSession"] as const) {
      expect(() => service.submit(pending.id, { decision, answers: { design: ["A"] } })).toThrow("仅支持提交回答");
    }
    expect(() => service.submit(pending.id, { decision: "accept", answers: {} })).toThrow("请回答");
    expect(() => service.submit(pending.id, { decision: "accept", answers: { design: ["invalid"] } })).toThrow("选项不正确");
    expect(responses).toEqual([]);
    expect(service.listPending("thread-1")).toHaveLength(1);
    service.submit(pending.id, { decision: "accept", answers: { design: ["B"] } });
    expect(responses).toEqual([{ id: "ask-1", result: { answers: { design: { answers: ["B"] } } } }]);
  });

  it("accepts typed MCP form answers and preserves explicit decline/cancel actions", () => {
    const { service, responses } = createHarness();
    const request = { method: "mcpServer/elicitation/request", params: {
      threadId: "thread-1", serverName: "ui-tool", mode: "form", message: "确认发布目标",
      requestedSchema: { type: "object", required: ["target", "count", "confirm"], properties: {
        target: { type: "string", enum: ["staging", "production"], enumNames: ["预发", "生产"] },
        count: { type: "integer", minimum: 1, maximum: 3 }, confirm: { type: "boolean" }, note: { type: "string" }
      } }
    } };
    service.handleServerRequest({ ...request, id: 1 });
    const form = service.listPending("thread-1")[0];
    expect(form).toMatchObject({ kind: "mcp_elicitation", interactionMode: "form", reason: "确认发布目标" });
    expect(form.questions[0].options?.[0]).toMatchObject({ label: "预发", value: "staging" });
    expect(() => service.submit(form.id, { decision: "accept", answers: { target: ["staging"], count: ["9"], confirm: ["true"] } })).toThrow("数值不正确");
    service.submit(form.id, { decision: "accept", answers: { target: ["staging"], count: ["2"], confirm: ["false"] } });
    expect(responses[0].result).toEqual({ action: "accept", content: { target: "staging", count: 2, confirm: false } });
    for (const [id, decision] of [[2, "decline"], [3, "cancel"]] as const) {
      service.handleServerRequest({ ...request, id });
      service.submit(service.listPending("thread-1")[0].id, { decision, answers: { target: ["production"] } });
      expect(responses.at(-1)?.result).toEqual({ action: decision, content: null });
    }
  });

  it("does not accept unsupported verification forms and clears requests resolved by another client", () => {
    const { service, eventHub, responses } = createHarness();
    service.handleServerRequest({ id: 9, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", mode: "openai/userVerification", title: "Verify", challenge: "test", description: "在原客户端验证" } });
    const pending = service.listPending("thread-1")[0];
    expect(pending.interactionMode).toBe("unsupported");
    expect(() => service.submit(pending.id, { decision: "accept" })).toThrow("原客户端");
    expect(responses).toEqual([]);
    service.resolveRequest("other-thread", 9);
    expect(service.listPending("thread-1")).toHaveLength(1);
    service.resolveRequest("thread-1", 9);
    expect(service.listPending("thread-1")).toEqual([]);
    expect(eventHub.getEvents("thread-1").at(-1)?.type).toBe("approval_resolved");
    expect(() => service.submit(pending.id, { decision: "accept" })).toThrow("already resolved");
  });

  it("tracks a command approval through one terminal decision", () => {
    const { service, eventHub, responses, pendingCounts } = createHarness();

    expect(service.handleServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm test",
        cwd: "/workspace"
      }
    })).toBe(true);

    const approval = service.listPending("thread-1")[0];
    expect(approval).toMatchObject({
      kind: "command_execution",
      status: "pending",
      command: "npm test",
      cwd: "/workspace"
    });
    expect(pendingCounts).toEqual([{ threadId: "thread-1", count: 1 }]);
    expect(eventHub.getEvents("thread-1")).toHaveLength(1);

    const resolved = service.submit(approval.id, { decision: "acceptForSession" });

    expect(resolved.status).toBe("approved_for_session");
    expect(responses).toEqual([{ id: 7, result: { decision: "acceptForSession" } }]);
    expect(service.listPending("thread-1")).toEqual([]);
    expect(pendingCounts.at(-1)).toEqual({ threadId: "thread-1", count: 0 });
    expect(eventHub.getEvents("thread-1").map((event) => event.type)).toEqual(["approval_requested", "approval_resolved"]);
    expect(() => service.submit(approval.id, { decision: "decline" })).toThrow("Approval already resolved");
  });

  it("maps permission and user-input approvals to app-server response shapes", () => {
    const { service, responses } = createHarness();

    service.handleServerRequest({
      id: 8,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        approvalId: "permission-1",
        permissions: { network: true, fileSystem: { read: ["/workspace"] } }
      }
    });
    service.submit("permission-1", { decision: "acceptForSession" });

    service.handleServerRequest({
      id: 9,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        approvalId: "question-1",
        questions: [{ id: "environment", header: "环境", question: "选择环境" }]
      }
    });
    service.submit("question-1", { decision: "accept", answers: { environment: ["生产"] } });

    expect(responses).toEqual([
      {
        id: 8,
        result: {
          permissions: { network: true, fileSystem: { read: ["/workspace"] } },
          scope: "session",
          strictAutoReview: false
        }
      },
      { id: 9, result: { answers: { environment: { answers: ["生产"] } } } }
    ]);
  });

  it("declines malformed approval requests without a thread id", () => {
    const { service, responses } = createHarness();

    expect(service.handleServerRequest({
      id: 10,
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-without-thread" }
    })).toBe(true);

    expect(responses).toEqual([{ id: 10, result: { decision: "decline" } }]);
    expect(service.getPendingCount("thread-1")).toBe(0);
  });
});
