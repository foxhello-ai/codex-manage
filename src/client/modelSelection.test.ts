import { describe, expect, it } from "vitest";
import type { ModelOption } from "../shared/models";
import { defaultEffortForModel, filterAndSortModels, modelSwitchDisabledReason } from "./modelSelection";

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
    expect(modelSwitchDisabledReason("waiting_input")).toBeNull();
    expect(modelSwitchDisabledReason("history")).toBeNull();
    expect(modelSwitchDisabledReason("failed")).toBeNull();
    expect(modelSwitchDisabledReason("exited")).toBeNull();
  });
});
