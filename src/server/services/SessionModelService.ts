import type {
  ModelOverrideInput,
  ModelSelectionResponse,
  PersistedModelSelection,
  ResolvedModelOverride,
  SessionModelState,
  UpdateModelSelectionInput
} from "../../shared/models";
import { ModelDomainError } from "../modelErrors";
import type { JsonlSessionParser } from "./JsonlSessionParser";
import type { ModelCatalogService } from "./ModelCatalogService";
import type { RuntimeManager } from "./RuntimeManager";
import type { SessionMetadataStore } from "./SessionMetadataStore";

type Catalog = Pick<ModelCatalogService, "list" | "validateSelection">;
type Metadata = Pick<SessionMetadataStore, "get" | "updateModelSelection">;
type Parser = Pick<JsonlSessionParser, "readModelState">;
type Runtime = Pick<RuntimeManager, "getRuntime" | "updateModel" | "hydrateModelState">;

export class SessionModelService {
  constructor(
    private readonly modelCatalog: Catalog,
    private readonly metadataStore: Metadata,
    private readonly jsonlParser: Parser,
    private readonly runtimeManager: Runtime
  ) {}

  async getSessionModelState(sessionId: string): Promise<SessionModelState> {
    const runtime = this.runtimeManager.getRuntime(sessionId);
    const persisted = (await this.metadataStore.get(sessionId)).modelSelection;
    const historical = await this.jsonlParser.readModelState(sessionId).catch(() => undefined);
    const actualModel = runtime.status !== "history" && runtime.model !== null
      ? runtime.model
      : historical?.state.model ?? null;
    const actualModelProvider = runtime.status !== "history" && runtime.modelProvider !== null
      ? runtime.modelProvider
      : historical?.state.modelProvider ?? null;
    const actualReasoningEffort = runtime.status !== "history" && runtime.reasoningEffort !== null
      ? runtime.reasoningEffort
      : historical?.state.reasoningEffort ?? null;
    const actualModelSupported = await this.isSupported(actualModel);

    if (runtime.status !== "history") {
      return {
        ...runtime.modelSelection,
        actualModel,
        actualModelProvider,
        actualReasoningEffort,
        actualModelSupported
      };
    }

    return {
      ...persisted,
      actualModel,
      actualModelProvider,
      actualReasoningEffort,
      actualModelSupported,
      applied: persisted.mode === "override" && persisted.preferredModel === actualModel,
      confirmationPending: false,
      lastError: null
    };
  }

  async updateSelection(sessionId: string, input: UpdateModelSelectionInput): Promise<ModelSelectionResponse> {
    const runtime = this.runtimeManager.getRuntime(sessionId);
    this.assertSwitchAllowed(runtime.status);

    if (input.mode === "follow_session") {
      const persisted = await this.metadataStore.updateModelSelection(sessionId, {
        mode: "follow_session",
        preferredModel: null,
        preferredReasoningEffort: null,
        updatedAt: new Date().toISOString()
      });
      const current = await this.getSessionModelState(sessionId);
      const selection: SessionModelState = {
        ...current,
        ...persisted.modelSelection,
        applied: false,
        confirmationPending: false,
        lastError: null
      };
      const nextRuntime = this.runtimeManager.hydrateModelState(sessionId, selection);
      return {
        selection: nextRuntime.modelSelection,
        runtime: nextRuntime,
        applied: false,
        confirmationPending: false
      };
    }

    const validated = await this.modelCatalog.validateSelection(input.model, input.reasoningEffort ?? null);
    if (
      runtime.status === "waiting_input"
      && runtime.modelSelection.mode === "override"
      && runtime.modelSelection.preferredModel === validated.model
      && runtime.modelSelection.preferredReasoningEffort === validated.reasoningEffort
      && runtime.modelSelection.applied
    ) {
      return {
        selection: runtime.modelSelection,
        runtime,
        applied: true,
        confirmationPending: runtime.modelSelection.confirmationPending
      };
    }

    const persistedSelection: PersistedModelSelection = {
      mode: "override",
      preferredModel: validated.model,
      preferredReasoningEffort: validated.reasoningEffort,
      updatedAt: new Date().toISOString()
    };

    if (runtime.status === "history" || runtime.status === "failed" || runtime.status === "exited") {
      await this.metadataStore.updateModelSelection(sessionId, persistedSelection);
      const current = await this.getSessionModelState(sessionId);
      const selection = {
        ...current,
        ...persistedSelection,
        applied: false,
        confirmationPending: false,
        lastError: null
      };
      const nextRuntime = this.runtimeManager.hydrateModelState(sessionId, selection);
      return {
        selection: nextRuntime.modelSelection,
        runtime: nextRuntime,
        applied: false,
        confirmationPending: false
      };
    }

    const appliedRuntime = await this.runtimeManager.updateModel(sessionId, validated);
    try {
      await this.metadataStore.updateModelSelection(sessionId, persistedSelection);
    } catch (error) {
      throw new ModelDomainError(
        "MODEL_PREFERENCE_PERSIST_FAILED",
        "模型已在当前进程应用，但偏好保存失败",
        500,
        {
          applied: true,
          model: appliedRuntime.model,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }

    const selection = {
      ...appliedRuntime.modelSelection,
      ...persistedSelection
    };
    const nextRuntime = this.runtimeManager.hydrateModelState(sessionId, selection);
    return {
      selection: nextRuntime.modelSelection,
      runtime: nextRuntime,
      applied: nextRuntime.modelSelection.applied,
      confirmationPending: nextRuntime.modelSelection.confirmationPending
    };
  }

  async resolveForResume(sessionId: string, requestOverride?: ModelOverrideInput): Promise<ResolvedModelOverride> {
    if (requestOverride?.model) {
      const validated = await this.modelCatalog.validateSelection(
        requestOverride.model,
        requestOverride.reasoningEffort ?? null
      );
      await this.metadataStore.updateModelSelection(sessionId, {
        mode: "override",
        preferredModel: validated.model,
        preferredReasoningEffort: validated.reasoningEffort,
        updatedAt: new Date().toISOString()
      });
      return {
        mode: "override",
        model: validated.model,
        reasoningEffort: validated.reasoningEffort
      };
    }
    return this.resolvePersisted(sessionId);
  }

  async resolveForTurn(sessionId: string): Promise<ResolvedModelOverride> {
    return this.resolvePersisted(sessionId);
  }

  private async resolvePersisted(sessionId: string): Promise<ResolvedModelOverride> {
    const selection = (await this.metadataStore.get(sessionId)).modelSelection;
    if (selection.mode !== "override" || !selection.preferredModel) {
      return {
        mode: "follow_session",
        model: null,
        reasoningEffort: null
      };
    }

    const validated = await this.modelCatalog.validateSelection(
      selection.preferredModel,
      selection.preferredReasoningEffort
    );
    return {
      mode: "override",
      model: validated.model,
      reasoningEffort: validated.reasoningEffort
    };
  }

  private assertSwitchAllowed(status: string) {
    if (status === "starting" || status === "running" || status === "waiting_approval") {
      throw new ModelDomainError("MODEL_SWITCH_NOT_ALLOWED", "当前会话状态不允许切换模型", 409, {
        status
      });
    }
  }

  private async isSupported(model: string | null): Promise<boolean | null> {
    if (!model) return null;
    try {
      const catalog = await this.modelCatalog.list();
      return catalog.models.some((option) => option.model === model);
    } catch {
      return null;
    }
  }
}
