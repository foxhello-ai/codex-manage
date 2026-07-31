import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareAdapter } from "./CloudflareAdapter";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflareAdapter", () => {
  it("treats already deleted DNS and Tunnel resources as a successful revocation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, result: [{ id: "dns-1", content: "cf-1.cfargotunnel.com" }] }))
      .mockResolvedValueOnce(jsonResponse(404, { success: false, result: null, errors: [{ code: 81044, message: "not found" }] }))
      .mockResolvedValueOnce(jsonResponse(404, { success: false, result: null, errors: [{ code: 1003, message: "not found" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new CloudflareAdapter("api-token", "account-1", "zone-1");
    await expect(adapter.deletePublishedTunnel("cf-1", "d-test.xmwefun.cn", "zone-runtime")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/zones/zone-runtime/dns_records");
  });

  it("writes a catch-all ingress rule after the device hostname", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new CloudflareAdapter("api-token", "account-1", "zone-1");

    await adapter.configurePublicHostname("cf-1", "d-test.xmwefun.cn", 4310);

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.config.ingress).toEqual([
      {
        hostname: "d-test.xmwefun.cn",
        service: "http://127.0.0.1:4310",
        originRequest: {}
      },
      { service: "http_status:404" }
    ]);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
