import { describe, expect, it } from "vitest";
import { ApprovalService } from "./ApprovalService";
import { EventHub } from "./EventHub";

function createHarness() {
  const responses: Array<{ id: number; result: unknown }> = [];
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
