import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./api";

const stopped = () => new Response(JSON.stringify({ error: { code: "CODEX_APP_SERVER_UNAVAILABLE", message: "app-server stopped" } }), { status: 503 });
afterEach(() => { vi.unstubAllGlobals(); });

describe("API reads during a runtime reload", () => {
  it("recovers one interrupted read", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stopped()).mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] })));
    vi.stubGlobal("fetch", fetch);
    await expect(apiRequest("/api/sessions")).resolves.toEqual({ sessions: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("limits retries when the runtime remains unavailable", async () => {
    const fetch = vi.fn().mockImplementation(async () => stopped());
    vi.stubGlobal("fetch", fetch);
    await expect(apiRequest("/api/sessions")).rejects.toThrow("app-server stopped");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never replays a mutation", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stopped());
    vi.stubGlobal("fetch", fetch);
    await expect(apiRequest("/api/sessions/id/input", { method: "POST" })).rejects.toThrow("app-server stopped");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces an unrelated service failure without retrying", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "CODEX_APP_SERVER_UNAVAILABLE", message: "history read failed" } }), { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(apiRequest("/api/sessions")).rejects.toThrow("history read failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
