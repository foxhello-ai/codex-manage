import { describe, expect, it } from "vitest";
import { resolveApiBase } from "./apiBase";

describe("resolveApiBase", () => {
  it("uses the same host for direct IPv4 access", () => {
    expect(resolveApiBase("https://codex-api.xmwefun.cn", {
      protocol: "http:",
      hostname: "192.168.31.107"
    })).toBe("http://192.168.31.107:4320");
  });

  it("keeps the configured API for domain access", () => {
    expect(resolveApiBase("https://codex-api.xmwefun.cn/", {
      protocol: "https:",
      hostname: "codex-admin.xmwefun.cn"
    })).toBe("https://codex-api.xmwefun.cn");
  });

  it("supports localhost and a custom direct port", () => {
    expect(resolveApiBase(undefined, {
      protocol: "http:",
      hostname: "localhost"
    }, "54320")).toBe("http://localhost:54320");
  });

  it("falls back to the production API domain when build-time config is missing", () => {
    expect(resolveApiBase(undefined, {
      protocol: "https:",
      hostname: "codex-admin.xmwefun.cn"
    })).toBe("https://codex-api.xmwefun.cn");
  });
});
