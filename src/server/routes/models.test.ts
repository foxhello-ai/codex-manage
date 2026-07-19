import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthHook } from "../auth/hooks";
import { ModelDomainError } from "../modelErrors";
import type { ModelCatalogService } from "../services/ModelCatalogService";
import { registerModelRoutes } from "./models";

function catalogService(list: ModelCatalogService["list"]): ModelCatalogService {
  return { list } as ModelCatalogService;
}

describe("model routes", () => {
  it("returns the model catalog and forwards refresh", async () => {
    const calls: unknown[] = [];
    const app = Fastify();
    registerModelRoutes(app, catalogService(async (query) => {
      calls.push(query);
      return {
        models: [],
        loadedAt: "2026-07-19T00:00:00.000Z",
        stale: false,
        lastError: null
      };
    }));

    const response = await app.inject({ method: "GET", url: "/api/models?refresh=true" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stale: false, models: [] });
    expect(calls).toEqual([{ forceRefresh: true }]);
  });

  it("rejects invalid refresh values", async () => {
    const app = Fastify();
    registerModelRoutes(app, catalogService(async () => {
      throw new Error("not used");
    }));
    const response = await app.inject({ method: "GET", url: "/api/models?refresh=yes" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_MODEL_QUERY" } });
  });

  it("maps model domain errors", async () => {
    const app = Fastify();
    registerModelRoutes(app, catalogService(async () => {
      throw new ModelDomainError("MODEL_LIST_UNAVAILABLE", "模型目录不可用", 503, { cause: "offline" });
    }));
    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "MODEL_LIST_UNAVAILABLE", message: "模型目录不可用" }
    });
  });

  it("requires authentication when installed with the application auth hook", async () => {
    const app = Fastify();
    await app.register(cookie, { secret: "test-secret-at-least-thirty-two-characters" });
    registerAuthHook(app);
    registerModelRoutes(app, catalogService(async () => ({
      models: [],
      loadedAt: "2026-07-19T00:00:00.000Z",
      stale: false,
      lastError: null
    })));

    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
