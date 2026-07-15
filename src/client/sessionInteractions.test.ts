import { describe, expect, it } from "vitest";
import { isTaskSendShortcut, shouldAutoFollowLiveOutput } from "./sessionInteractions";

describe("session interactions", () => {
  it("auto-follows live output only while starting or running", () => {
    expect(shouldAutoFollowLiveOutput("starting")).toBe(true);
    expect(shouldAutoFollowLiveOutput("running")).toBe(true);
    expect(shouldAutoFollowLiveOutput("waiting_input")).toBe(false);
    expect(shouldAutoFollowLiveOutput("waiting_approval")).toBe(false);
    expect(shouldAutoFollowLiveOutput("history")).toBe(false);
  });

  it("recognizes Ctrl+Enter and Meta+Enter without accepting repeats", () => {
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: true, metaKey: false, repeat: false })).toBe(true);
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: false, metaKey: true, repeat: false })).toBe(true);
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: false, metaKey: false, repeat: false })).toBe(false);
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: true, metaKey: false, repeat: true })).toBe(false);
    expect(isTaskSendShortcut({ key: "a", ctrlKey: true, metaKey: false, repeat: false })).toBe(false);
  });
});
