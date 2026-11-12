import { describe, expect, it } from "vitest";
import type { ModelOption, RuntimeSnapshot, SessionModelState } from "../shared/models";
import { defaultEffortForModel, filterAndSortModels, modelStateAfterRuntimeSnapshot, modelSwitchDisabledReason } from "./modelSelection";

function model(id: string, patch: Partial<ModelOption> = {}): ModelOption {
  return {
    id,
    model: id,
    displayName: id,
    description: null,
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
    upgradeModel: null,
    upgradeCopy: null,
    ...patch
  };
}

function modelState(actualModel: string | null): SessionModelState {
  return {
    mode: "follow_session",
    preferredModel: null,
    preferredReasoningEffort: null,
    updatedAt: null,
    actualModel,
    actualModelProvider: actualModel ? "openai" : null,
    actualReasoningEffort: actualModel ? "high" : null,
    actualModelSupported: null,
    applied: false,
    confirmationPending: false,
    lastError: null
  };
}

function runtime(status: RuntimeSnapshot["status"], selection: SessionModelState): RuntimeSnapshot {
  return {
    threadId: "thread-1",
    status,
    permissionMode: "default",
    activeTurnId: null,
    startedAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    lastError: null,
    pendingApprovalCount: 0,
    eventSeq: 1,
    model: selection.actualModel,
    modelProvider: selection.actualModelProvider,
    reasoningEffort: selection.actualReasoningEffort,
    modelSelection: selection,
    modelChangeStatus: "idle",
    modelChangeError: null
  };
}

describe("model selection helpers", () => {
  it("filters by id, name, and description while keeping default first", () => {
    const models = [
      model("beta", { description: "fast model" }),
      model("alpha", { displayName: "Frontier", isDefault: true })
    ];
    expect(filterAndSortModels(models, "")).toMatchObject([{ model: "alpha" }, { model: "beta" }]);
    expect(filterAndSortModels(models, "front")).toMatchObject([{ model: "alpha" }]);
    expect(filterAndSortModels(models, "fast")).toMatchObject([{ model: "beta" }]);
  });

  it("keeps supported effort and otherwise uses the target default", () => {
    const option = model("alpha");
    expect(defaultEffortForModel(option, "high")).toBe("high");
    expect(defaultEffortForModel(option, "xhigh")).toBe("low");
    expect(defaultEffortForModel(model("plain", { supportedReasoningEfforts: [], defaultReasoningEffort: null }), "high")).toBeNull();
  });

  it("explains only statuses that prohibit switching", () => {
    expect(modelSwitchDisabledReason("starting")).toContain("恢复中");
    expect(modelSwitchDisabledReason("running")).toContain("运行中");
    expect(modelSwitchDisabledReason("waiting_approval")).toContain("审批");
    expect(modelSwitchDisabledReason("waiting_user")).toContain("回答");
    expect(modelSwitchDisabledReason("waiting_input")).toBeNull();
    expect(modelSwitchDisabledReason("history")).toBeNull();
    expect(modelSwitchDisabledReason("failed")).toBeNull();
    expect(modelSwitchDisabledReason("exited")).toBeNull();
  });

  it("preserves historical model state when an empty history runtime snapshot arrives", () => {
    const historical = modelState("gpt-5.6-sol");
    expect(modelStateAfterRuntimeSnapshot(historical, runtime("history", modelState(null)))).toBe(historical);
    expect(modelStateAfterRuntimeSnapshot(historical, runtime("waiting_input", modelState("gpt-5.7")))).toMatchObject({
      actualModel: "gpt-5.7"
    });
  });
});
