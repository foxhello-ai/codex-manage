import { describe, expect, it } from "vitest";
import { findRetryContextForTurn, findRetryContextFromFailedTurns, isCommentaryPhase, isFinalAnswerPhase, isTaskSendShortcut, isUnmaterializedThreadHistoryError } from "./sessionInteractions";

describe("session interactions", () => {
  it("recognizes the expected pre-message history response", () => {
    expect(isUnmaterializedThreadHistoryError(
      "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message"
    )).toBe(true);
    expect(isUnmaterializedThreadHistoryError("历史消息加载失败")).toBe(false);
  });

  it("recognizes Ctrl+Enter and Meta+Enter without accepting repeats", () => {
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: true, metaKey: false, repeat: false })).toBe(true);
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: false, metaKey: true, repeat: false })).toBe(true);
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: false, metaKey: false, repeat: false })).toBe(false);
    expect(isTaskSendShortcut({ key: "Enter", ctrlKey: true, metaKey: false, repeat: true })).toBe(false);
    expect(isTaskSendShortcut({ key: "a", ctrlKey: true, metaKey: false, repeat: false })).toBe(false);
  });

  it("recognizes final answers and commentary phases", () => {
    expect(isFinalAnswerPhase("final_answer")).toBe(true);
    expect(isFinalAnswerPhase("final")).toBe(true);
    expect(isFinalAnswerPhase("commentary")).toBe(false);
    expect(isCommentaryPhase("commentary")).toBe(true);
    expect(isCommentaryPhase("final_answer")).toBe(false);
  });

  it("keeps retry tied to the matching live turn when text repeats", () => {
    const turns = [
      {
        id: "turn-first",
        status: "failed",
        error: "first error",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: null,
        durationMs: null,
        items: [{ id: "history-first", type: "user_message" as const, text: "same text" }]
      },
      {
        id: "turn-second",
        status: "failed",
        error: "second error",
        startedAt: "2026-08-14T00:01:00.000Z",
        completedAt: null,
        durationMs: null,
        items: [{ id: "history-second", type: "user_message" as const, text: "same text" }]
      }
    ];

    expect(findRetryContextForTurn("turn-first", [
      { id: "live-second", role: "user", turnId: "turn-second", text: "same text" },
      { id: "live-first", role: "user", turnId: "turn-first", text: "same text" }
    ], turns)).toEqual({ messageId: "live-first", turnId: "turn-first", text: "same text" });
  });

  it("restores the newest failed historical turn after refresh", () => {
    const turns = [
      {
        id: "turn-done",
        status: "completed",
        error: null,
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:10.000Z",
        durationMs: 10_000,
        items: [{ id: "done-user", type: "user_message" as const, text: "do not retry" }]
      },
      {
        id: "turn-failed",
        status: "failed",
        error: "upstream unavailable",
        startedAt: "2026-08-14T00:01:00.000Z",
        completedAt: null,
        durationMs: null,
        items: [
          { id: "failed-user", type: "user_message" as const, text: "retry this exact request" },
          { id: "failed-agent", type: "agent_message" as const, text: "", phase: null }
        ]
      }
    ];

    expect(findRetryContextFromFailedTurns(turns)).toEqual({
      messageId: "failed-user",
      turnId: "turn-failed",
      text: "retry this exact request"
    });
  });
});
