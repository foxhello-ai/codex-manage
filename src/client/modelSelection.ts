import type { ModelOption, RuntimeSnapshot, SessionModelState, SessionStatus } from "../shared/models";

export function filterAndSortModels(models: ModelOption[], search: string): ModelOption[] {
  const term = search.trim().toLocaleLowerCase();
  return models
    .filter((model) => !term || [model.model, model.displayName, model.description]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(term)))
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.displayName.localeCompare(right.displayName, "zh-CN");
    });
}

export function defaultEffortForModel(model: ModelOption, previous: string | null): string | null {
  if (previous && model.supportedReasoningEfforts.includes(previous)) return previous;
  return model.defaultReasoningEffort && model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : null;
}

export function modelSwitchDisabledReason(status: SessionStatus): string | null {
  switch (status) {
    case "starting":
      return "恢复中，暂不可切换模型";
    case "running":
      return "任务运行中，完成后可切换模型";
    case "waiting_user":
      return "请先回答问题，再切换模型";
    case "waiting_approval":
      return "请先处理审批，再切换模型";
    default:
      return null;
  }
}

export function modelStateAfterRuntimeSnapshot(
  current: SessionModelState,
  runtime: RuntimeSnapshot
): SessionModelState {
  return runtime.status === "history" ? current : runtime.modelSelection;
}
