import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticText } from "./DiagnosticLog";

describe("sanitizeDiagnosticText", () => {
  it("redacts credentials, identifiers, URLs and home paths", () => {
    const input = [
      "Bearer cm_access_secret",
      "cm_refresh_secret",
      "owner@example.com",
      "+8613800138000",
      "https://device.example.com/#/pair?code=secret",
      "/Users/alice/project"
    ].join(" ");

    const output = sanitizeDiagnosticText(input);

    expect(output).not.toContain("secret");
    expect(output).not.toContain("owner@example.com");
    expect(output).not.toContain("13800138000");
    expect(output).not.toContain("device.example.com");
    expect(output).not.toContain("/Users/alice");
  });
});
