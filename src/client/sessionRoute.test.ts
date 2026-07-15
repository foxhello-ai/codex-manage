import { describe, expect, it } from "vitest";
import { buildSessionDetailPath, parseSessionRoute } from "./sessionRoute";

describe("session routes", () => {
  it("parses the root path as the session list", () => {
    expect(parseSessionRoute("/")).toEqual({ kind: "list" });
    expect(parseSessionRoute("")).toEqual({ kind: "list" });
  });

  it("parses the reserved settings path", () => {
    expect(parseSessionRoute("/settings")).toEqual({ kind: "settings" });
  });

  it("parses and decodes one session path segment", () => {
    expect(parseSessionRoute("/thread-123")).toEqual({ kind: "detail", sessionId: "thread-123" });
    expect(parseSessionRoute("/thread%20name")).toEqual({ kind: "detail", sessionId: "thread name" });
  });

  it("rejects malformed and multi-segment paths", () => {
    expect(parseSessionRoute("/thread/child")).toMatchObject({ kind: "invalid" });
    expect(parseSessionRoute("/thread/")).toMatchObject({ kind: "invalid" });
    expect(parseSessionRoute("/%E0%A4%A")).toMatchObject({ kind: "invalid" });
  });

  it("builds an encoded detail path", () => {
    expect(buildSessionDetailPath("thread-123")).toBe("/thread-123");
    expect(buildSessionDetailPath("thread name/test")).toBe("/thread%20name%2Ftest");
    expect(() => buildSessionDetailPath("")).toThrow("Session ID is required");
  });
});
