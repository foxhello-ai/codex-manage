import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudClient } from "./CloudClient";

describe("CloudClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("loads desktop config from an explicit candidate base URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://bootstrap.example.com/v1/desktop/config");
      return new Response(JSON.stringify({
        desktop: {
          schema_version: 1,
          api_base_url: "https://api.example.com",
          update_feed_url: "https://api.example.com/updates/stable",
          managed_domain_suffixes: ["example.com"],
          config_ttl_seconds: 3600,
          generated_at: "2026-07-30T00:00:00.000Z"
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new CloudClient("https://old.example.com/");
    const config = await client.getDesktopConfig("https://bootstrap.example.com/");
    client.setBaseUrl(config.desktop.api_base_url);

    expect(client.getBaseUrl()).toBe("https://api.example.com");
    expect(config.desktop.managed_domain_suffixes).toEqual(["example.com"]);
  });
});
