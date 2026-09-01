import { describe, expect, it } from "vitest";
import type { PersistedModelSelection, RuntimeSnapshot } from "../../shared/models";
import { SessionModelService } from "./SessionModelService";

function modelOption(model = "gpt-5.6-sol") {
  return {
    id: model,
    model,
    displayName: model,
    description: null,
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
    upgradeModel: null,
    upgradeCopy: null
  };
}

function runtimeSnapshot(status: "history" | "waiting_input" | "running" | "failed" = "history"): RuntimeSnapshot {
  return {
    threadId: "thread-1",
    status,
    permissionMode: "default" as const,
    activeTurnId: status === "running" ? "turn-1" : null,
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastError: null,
    pendingApprovalCount: 0,
    eventSeq: 0,
    model: status === "waiting_input" ? "old-model" : null,
    modelProvider: null,
    reasoningEffort: null,
    modelSelection: {
      mode: "follow_session" as const,
      preferredModel: null,
      preferredReasoningEffort: null,
      actualModel: status === "waiting_input" ? "old-model" : null,
      actualModelProvider: null,
      actualReasoningEffort: null,
      actualModelSupported: null,
      applied: false,
      confirmationPending: false,
      updatedAt: null,
      lastError: null
    },
    modelChangeStatus: "idle" as const,
    modelChangeError: null
  };
}

function fixture(status: "history" | "waiting_input" | "running" | "failed" = "history") {
  let runtime = runtimeSnapshot(status);
  let persisted: PersistedModelSelection = {
    mode: "follow_session" as const,
    preferredModel: null as string | null,
    preferredReasoningEffort: null as string | null,
    updatedAt: null as string | null
  };
  const updateCalls: unknown[] = [];
  const runtimeUpdateCalls: unknown[] = [];

  const service = new SessionModelService(
    {
      list: async () => ({
        models: [modelOption()],
        loadedAt: "2026-07-19T00:00:00.000Z",
        stale: false,
        lastError: null
      }),
      validateSelection: async (model, reasoningEffort) => ({
        model: model.trim(),
        reasoningEffort,
        option: modelOption(model.trim())
      })
    },
    {
      get: async () => ({ permissionMode: "default", remarkTitle: null, modelSelection: persisted }),
      updateModelSelection: async (_sessionId, selection) => {
        persisted = { ...selection } as typeof persisted;
        updateCalls.push(selection);
        return { permissionMode: "default", remarkTitle: null, modelSelection: persisted };
      }
    },
    {
      readModelState: async () => ({
        state: { model: "historical-model", modelProvider: "custom", reasoningEffort: "low", updatedAt: null },
        diagnostics: { scannedFiles: 1, parsedLines: 2, parseErrors: 0, matchedSessionFile: true }
      })
    },
    {
      getRuntime: () => runtime,
      updateModel: async (_sessionId, selection) => {
        runtimeUpdateCalls.push(selection);
        runtime = {
          ...runtime,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
          modelSelection: {
            ...runtime.modelSelection,
            mode: "override",
            preferredModel: selection.model,
            preferredReasoningEffort: selection.reasoningEffort,
            actualModel: selection.model,
            actualReasoningEffort: selection.reasoningEffort,
            actualModelSupported: true,
            applied: true
          },
          modelChangeStatus: "applied"
        };
        return runtime;
      },
      hydrateModelState: (_sessionId, state) => {
        runtime = {
          ...runtime,
          model: state.actualModel,
          modelProvider: state.actualModelProvider,
          reasoningEffort: state.actualReasoningEffort,
          modelSelection: state
        };
        return runtime;
      }
    }
  );

  return { service, updateCalls, runtimeUpdateCalls, getRuntime: () => runtime };
}

describe("SessionModelService", () => {
  it("stores an inactive override without calling app-server", async () => {
    const { service, updateCalls, runtimeUpdateCalls } = fixture("history");
    const result = await service.updateSelection("thread-1", {
      mode: "override",
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    });

    expect(updateCalls).toHaveLength(1);
    expect(runtimeUpdateCalls).toHaveLength(0);
    expect(result).toMatchObject({
      applied: false,
      selection: {
        mode: "override",
        preferredModel: "gpt-5.6-sol",
        preferredReasoningEffort: "high"
      }
    });
  });

  it("applies a waiting-input override before persisting it", async () => {
    const { service, updateCalls, runtimeUpdateCalls } = fixture("waiting_input");
    const result = await service.updateSelection("thread-1", {
      mode: "override",
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    });

    expect(runtimeUpdateCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
    expect(result).toMatchObject({
      applied: true,
      selection: { actualModel: "gpt-5.6-sol", preferredModel: "gpt-5.6-sol" }
    });
  });

  it("rejects switching while running", async () => {
    const { service, updateCalls, runtimeUpdateCalls } = fixture("running");
    await expect(service.updateSelection("thread-1", {
      mode: "override",
      model: "gpt-5.6-sol"
    })).rejects.toMatchObject({ code: "MODEL_SWITCH_NOT_ALLOWED", statusCode: 409 });
    expect(updateCalls).toHaveLength(0);
    expect(runtimeUpdateCalls).toHaveLength(0);
  });

  it("clears web preference without sending model null", async () => {
    const { service, updateCalls, runtimeUpdateCalls, getRuntime } = fixture("waiting_input");
    const result = await service.updateSelection("thread-1", { mode: "follow_session" });

    expect(updateCalls).toHaveLength(1);
    expect(runtimeUpdateCalls).toHaveLength(0);
    expect(result.selection.mode).toBe("follow_session");
    expect(getRuntime().model).toBe("old-model");
  });

  it("validates and persists an explicit resume override", async () => {
    const { service, updateCalls } = fixture("history");
    await expect(service.resolveForResume("thread-1", {
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    })).resolves.toEqual({
      mode: "override",
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    });
    expect(updateCalls).toHaveLength(1);
  });
});
