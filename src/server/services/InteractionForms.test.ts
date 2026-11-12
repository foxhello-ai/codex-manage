import { describe, expect, it } from "vitest";
import { buildMcpContent, readMcpForm } from "./InteractionForms";

describe("MCP form validation", () => {
  it("enforces array constraints and preserves typed values and enum wire values", () => {
    const questions = readMcpForm({ type: "object", required: ["targets", "confirm"], properties: {
      targets: { type: "array", items: { type: "string", enum: ["a", "b"], enumNames: ["界面A", "界面B"] }, minItems: 1, maxItems: 2, uniqueItems: true },
      confirm: { type: "boolean" }, optional: { type: "array", items: { type: "string", enum: ["x"] }, minItems: 1 }
    } })!;
    expect(buildMcpContent(questions, { targets: ["a", "b"], confirm: ["false"] })).toEqual({ targets: ["a", "b"], confirm: false });
    expect(() => buildMcpContent(questions, { targets: ["a", "a"], confirm: ["true"] })).toThrow("选择数量");
    expect(() => buildMcpContent(questions, { targets: ["unknown"], confirm: ["true"] })).toThrow("选项");
  });
  it("does not silently drop unsupported schema requirements", () => {
    for (const field of [{ type: "string", format: "email" }, { type: "string", pattern: "^a" }, { type: "object", properties: {} }, { type: "integer", exclusiveMinimum: 1 }]) {
      expect(readMcpForm({ type: "object", properties: { field } })).toBeNull();
    }
    expect(readMcpForm({ type: "object", properties: {}, required: ["missing"] })).toBeNull();
  });
});
