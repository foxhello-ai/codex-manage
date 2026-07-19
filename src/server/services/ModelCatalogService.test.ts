import { describe, expect, it } from "vitest";
import { ModelDomainError } from "../modelErrors";
import { ModelCatalogService } from "./ModelCatalogService";

function rawModel(model: string, patch: Record<string, unknown> = {}) {
  return {
    id: model,
    model,
    displayName: model.toUpperCase(),
    description: `${model} description`,
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "medium", description: "Medium" },
      { reasoningEffort: "high", description: "High" }
    ],
    ...patch
  };
}

function readyClient(handler: (method: string, params: any) => unknown | Promise<unknown>) {
  const requests: Array<{ method: string; params: any }> = [];
  return {
    requests,
    getSnapshot: () => ({ status: "ready" as const, pid: 1, lastError: null, initialized: true }),
    request: async <T>(method: string, params: any) => {
      requests.push({ method, params });
      return await handler(method, params) as T;
    }
  };
}

describe("ModelCatalogService", () => {
  it("paginates, filters hidden models, deduplicates, normalizes, and sorts", async () => {
    const client = readyClient((_method, params) => params.cursor === null
      ? {
          data: [
            rawModel("beta"),
            rawModel("hidden", { hidden: true }),
            rawModel("alpha", {
              isDefault: true,
              upgradeInfo: { model: "next", upgradeCopy: "Try next" }
            })
          ],
          nextCursor: "page-2"
        }
      : {
          data: [rawModel("beta", { displayName: "duplicate" }), rawModel("charlie")],
          nextCursor: null
        });
    const service = new ModelCatalogService(client, { now: () => 1_000 });

    const catalog = await service.list();

    expect(client.requests).toEqual([
      { method: "model/list", params: { cursor: null, limit: 100, includeHidden: true } },
      { method: "model/list", params: { cursor: "page-2", limit: 100, includeHidden: true } }
    ]);
    expect(catalog).toMatchObject({
      stale: false,
      loadedAt: new Date(1_000).toISOString(),
      models: [
        { model: "alpha", isDefault: true, upgradeModel: "next", upgradeCopy: "Try next" },
        { model: "beta", displayName: "BETA" },
        { model: "charlie" }
      ]
    });
  });

  it("uses a 60 second cache and supports forced refresh", async () => {
    let now = 5_000;
    let calls = 0;
    const client = readyClient(() => {
      calls += 1;
      return { data: [rawModel(`model-${calls}`)], nextCursor: null };
    });
    const service = new ModelCatalogService(client, { now: () => now });

    expect((await service.list()).models[0].model).toBe("model-1");
    now += 59_000;
    expect((await service.list()).models[0].model).toBe("model-1");
    expect((await service.list({ forceRefresh: true })).models[0].model).toBe("model-2");
    expect(calls).toBe(2);
  });

  it("coalesces concurrent refreshes", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const client = readyClient(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const service = new ModelCatalogService(client);

    const first = service.list();
    const second = service.list({ forceRefresh: true });
    await Promise.resolve();
    expect(client.requests).toHaveLength(1);
    resolveResponse?.({ data: [rawModel("alpha")], nextCursor: null });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("returns stale cache on refresh failure and fails clearly without cache", async () => {
    let fail = false;
    const client = readyClient(() => {
      if (fail) throw new Error("Authorization: secret upstream unavailable");
      return { data: [rawModel("alpha")], nextCursor: null };
    });
    const service = new ModelCatalogService(client);
    await service.list();
    fail = true;

    const stale = await service.list({ forceRefresh: true });
    expect(stale).toMatchObject({ stale: true, models: [{ model: "alpha" }] });
    expect(stale.lastError).toContain("[REDACTED]");
    expect(stale.lastError).not.toContain("secret");

    const emptyService = new ModelCatalogService(readyClient(() => {
      throw new Error("offline");
    }));
    await expect(emptyService.list()).rejects.toMatchObject({
      code: "MODEL_LIST_UNAVAILABLE",
      statusCode: 503
    });
  });

  it("refreshes once for a missing model and validates reasoning effort", async () => {
    let calls = 0;
    const client = readyClient(() => {
      calls += 1;
      return { data: [rawModel(calls === 1 ? "alpha" : "beta")], nextCursor: null };
    });
    const service = new ModelCatalogService(client);

    await expect(service.validateSelection(" beta ", "high")).resolves.toMatchObject({
      model: "beta",
      reasoningEffort: "high"
    });
    expect(calls).toBe(2);

    await expect(service.validateSelection("beta", "xhigh")).rejects.toMatchObject({
      code: "MODEL_EFFORT_NOT_SUPPORTED",
      statusCode: 422
    });
    await expect(service.validateSelection("missing", null)).rejects.toBeInstanceOf(ModelDomainError);
  });
});
