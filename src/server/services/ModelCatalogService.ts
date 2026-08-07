import type { ModelCatalogResponse, ModelOption, ValidatedModelSelection } from "../../shared/models";
import { ModelDomainError, sanitizeModelError } from "../modelErrors";
import type { CodexAppServerClient } from "./CodexAppServerClient";

type ModelListResponse = {
  data?: unknown[];
  nextCursor?: string | null;
};

type ModelCatalogCache = {
  models: ModelOption[];
  loadedAt: string;
  expiresAtMs: number;
};

type ModelCatalogClient = Pick<CodexAppServerClient, "request" | "getSnapshot">;

export type ModelCatalogServiceOptions = {
  cacheTtlMs?: number;
  pageSize?: number;
  maxPages?: number;
  now?: () => number;
};

export class ModelCatalogService {
  private readonly cacheTtlMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private cache: ModelCatalogCache | null = null;
  private refreshPromise: Promise<ModelCatalogResponse> | null = null;

  constructor(
    private readonly appServer: ModelCatalogClient,
    options: ModelCatalogServiceOptions = {}
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPages ?? 20;
    this.now = options.now ?? Date.now;
  }

  async list(query: { forceRefresh?: boolean; allowStale?: boolean } = {}): Promise<ModelCatalogResponse> {
    if (!query.forceRefresh && this.cache && this.cache.expiresAtMs > this.now()) {
      return this.snapshot(this.cache, false, null);
    }

    if (!query.forceRefresh && query.allowStale && this.cache) {
      void this.startRefresh();
      return this.snapshot(this.cache, true, null);
    }

    return this.startRefresh();
  }

  isModelSupportedFromCache(model: string): boolean | null {
    const normalized = model.trim();
    if (!normalized || !this.cache) return null;
    return this.cache.models.some((option) => option.model === normalized);
  }

  private startRefresh(): Promise<ModelCatalogResponse> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async getSupportedModel(model: string): Promise<ModelOption | null> {
    const normalized = model.trim();
    if (!normalized) return null;
    const catalog = await this.list();
    return catalog.models.find((option) => option.model === normalized) ?? null;
  }

  async validateSelection(model: string, reasoningEffort: string | null): Promise<ValidatedModelSelection> {
    const normalizedModel = model.trim();
    if (!normalizedModel || normalizedModel.length > 200) {
      throw new ModelDomainError("MODEL_NOT_SUPPORTED", "请求模型不在当前支持列表中", 422, {
        model: normalizedModel.slice(0, 200)
      });
    }

    let catalog = await this.list();
    let option = catalog.models.find((candidate) => candidate.model === normalizedModel) ?? null;
    if (!option) {
      catalog = await this.list({ forceRefresh: true });
      option = catalog.models.find((candidate) => candidate.model === normalizedModel) ?? null;
    }

    if (!option) {
      throw new ModelDomainError("MODEL_NOT_SUPPORTED", "请求模型不在当前支持列表中", 422, {
        model: normalizedModel
      });
    }

    const normalizedEffort = normalizeOptionalString(reasoningEffort);
    if (normalizedEffort && !option.supportedReasoningEfforts.includes(normalizedEffort)) {
      throw new ModelDomainError("MODEL_EFFORT_NOT_SUPPORTED", "目标模型不支持该推理强度", 422, {
        model: normalizedModel,
        reasoningEffort: normalizedEffort,
        supportedReasoningEfforts: option.supportedReasoningEfforts
      });
    }

    return {
      model: option.model,
      reasoningEffort: normalizedEffort,
      option
    };
  }

  invalidate(): void {
    this.cache = null;
  }

  private async refresh(): Promise<ModelCatalogResponse> {
    try {
      this.assertReady();
      const rawModels: unknown[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < this.maxPages; page += 1) {
        const response = await this.appServer.request<ModelListResponse>("model/list", {
          cursor,
          limit: this.pageSize,
          includeHidden: true
        });
        rawModels.push(...(Array.isArray(response.data) ? response.data : []));
        cursor = normalizeOptionalString(response.nextCursor);
        if (!cursor) break;
        if (page === this.maxPages - 1) {
          throw new Error(`model/list exceeded ${this.maxPages} pages`);
        }
      }

      const models = normalizeModels(rawModels);
      const loadedAt = new Date(this.now()).toISOString();
      const cache = {
        models,
        loadedAt,
        expiresAtMs: this.now() + this.cacheTtlMs
      } satisfies ModelCatalogCache;
      this.cache = cache;
      return this.snapshot(cache, false, null);
    } catch (error) {
      const message = sanitizeModelError(error);
      if (this.cache) return this.snapshot(this.cache, true, message);
      throw new ModelDomainError("MODEL_LIST_UNAVAILABLE", "无法读取当前支持模型列表", 503, {
        cause: message
      });
    }
  }

  private assertReady(): void {
    const snapshot = this.appServer.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.initialized) {
      throw new Error("Codex app-server is not ready");
    }
  }

  private snapshot(cache: ModelCatalogCache, stale: boolean, lastError: string | null): ModelCatalogResponse {
    return {
      models: cache.models.map((model) => ({ ...model, supportedReasoningEfforts: [...model.supportedReasoningEfforts] })),
      loadedAt: cache.loadedAt,
      stale,
      lastError
    };
  }
}

function normalizeModels(values: unknown[]): ModelOption[] {
  const unique = new Map<string, ModelOption>();

  for (const value of values) {
    const model = normalizeModel(value);
    if (!model || model.hidden || unique.has(model.model)) continue;
    unique.set(model.model, model);
  }

  return [...unique.values()].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    const byName = left.displayName.localeCompare(right.displayName, "zh-CN");
    return byName !== 0 ? byName : left.model.localeCompare(right.model);
  });
}

function normalizeModel(value: unknown): ModelOption | null {
  const source = asRecord(value);
  const model = normalizeOptionalString(source.model);
  if (!model) return null;
  const id = normalizeOptionalString(source.id) ?? model;
  const upgradeInfo = asRecord(source.upgradeInfo);
  const supportedReasoningEfforts = Array.isArray(source.supportedReasoningEfforts)
    ? source.supportedReasoningEfforts
        .map((effort) => typeof effort === "string" ? effort : normalizeOptionalString(asRecord(effort).reasoningEffort))
        .filter((effort): effort is string => Boolean(effort))
    : [];

  return {
    id,
    model,
    displayName: normalizeOptionalString(source.displayName) ?? model,
    description: normalizeOptionalString(source.description),
    hidden: source.hidden === true,
    isDefault: source.isDefault === true,
    supportedReasoningEfforts: [...new Set(supportedReasoningEfforts)],
    defaultReasoningEffort: normalizeOptionalString(source.defaultReasoningEffort),
    upgradeModel: normalizeOptionalString(upgradeInfo.model) ?? normalizeOptionalString(source.upgrade),
    upgradeCopy: normalizeOptionalString(upgradeInfo.upgradeCopy)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
