import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { registerStaticClient } from "./staticClient";

const clientRoot = fileURLToPath(new URL("./test-fixtures/client", import.meta.url));
const app = Fastify();

beforeAll(async () => {
  app.get("/api/ping", async () => ({ ok: true }));
  await registerStaticClient(app, clientRoot);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("production static client", () => {
  it("serves the client entry and existing assets", async () => {
    const rootResponse = await app.inject({ method: "GET", url: "/" });
    const assetResponse = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(rootResponse.statusCode).toBe(200);
    expect(rootResponse.body).toContain("codex-manage-spa-fixture");
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.body).toContain("fixtureLoaded");
  });

  it("falls back to the SPA entry for detail navigation", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/019f5c9c-e49a-7ea1-b753-5bea33b7a17e",
      headers: { accept: "text/html" }
    });
    const headResponse = await app.inject({
      method: "HEAD",
      url: "/019f5c9c-e49a-7ea1-b753-5bea33b7a17e",
      headers: { accept: "text/html" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toContain("codex-manage-spa-fixture");
    expect(headResponse.statusCode).toBe(200);
    expect(headResponse.body).toBe("");
  });

  it("does not return SPA HTML for missing API or asset paths", async () => {
    const apiResponse = await app.inject({
      method: "GET",
      url: "/api/missing",
      headers: { accept: "text/html" }
    });
    const assetResponse = await app.inject({
      method: "GET",
      url: "/assets/missing.js",
      headers: { accept: "text/html" }
    });

    expect(apiResponse.statusCode).toBe(404);
    expect(apiResponse.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(assetResponse.statusCode).toBe(404);
    expect(assetResponse.body).not.toContain("codex-manage-spa-fixture");
  });

  it("keeps registered API routes ahead of the SPA fallback", async () => {
    const response = await app.inject({ method: "GET", url: "/api/ping" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
