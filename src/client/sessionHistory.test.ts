import { describe, expect, it } from "vitest";
import { mergeSessionHistory, mergeDesktopTurns } from "./sessionHistory";
import type { SessionDetail, SessionTurn } from "../shared/models";

const turn = (id: string, startedAt: string, status = "completed") => ({ id, startedAt, status, items: [] }) as unknown as SessionTurn;
const detail = (turns: SessionTurn[], nextCursor: string | null, version = "v1") => ({ id: "thread-1", turns, historyPage: { nextCursor, version, unchanged: false } }) as SessionDetail;

describe("mergeSessionHistory", () => {
  it("updates a live message without dropping loaded older pages, duplicating IDs or moving durable turns", () => {
    const previous = { ...turn("t2", "", "inProgress"), items: [{ id: "message", type: "agent_message", text: "旧进度", phase: "commentary" }] } as SessionTurn;
    const update = { ...previous, items: [{ ...previous.items[0], text: "新进度" }] } as SessionTurn;
    const result = mergeDesktopTurns([turn("t1", ""), previous, turn("t3", "")], [update]);
    expect(result.map(t => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(result[1].items).toEqual(update.items);
    expect(mergeDesktopTurns([turn("t3", "")], [turn("t2", ""), turn("t3", ""), turn("t4", "")]).map(t => t.id)).toEqual(["t2", "t3", "t4"]);
    expect(mergeDesktopTurns([turn("t3", "", "completed")], [turn("t3", "", "inProgress")])[0].status).toBe("completed");
  });
  it("preserves server ordering with equal or missing timestamps and does not overwrite recent turns with an older page", () => {
    const current = detail([turn("t9", ""), turn("t10", "", "running")], "cursor");
    const merged = mergeSessionHistory(current, detail([turn("t8", ""), turn("t9", ""), turn("t10", "")], null), true);
    expect(merged.turns.map(turn => turn.id)).toEqual(["t8", "t9", "t10"]);
    expect(merged.turns[2].status).toBe("running");
  });
  it("merges older pages and current-turn updates without losing the older-page cursor", () => {
    const recent = detail([turn("t2", "2"), turn("t3", "3", "running")], "older");
    const older = mergeSessionHistory(recent, detail([turn("t1", "1"), turn("t2", "2")], null), true);
    const refreshed = mergeSessionHistory(older, detail([turn("t3", "3"), turn("t4", "4")], "older", "v2"), false);
    expect(refreshed.turns.map(turn => turn.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(refreshed.turns[2].status).toBe("completed");
    expect(refreshed.historyPage).toEqual({ nextCursor: null, version: "v2", unchanged: false });
  });
  it("takes the first page after summary load and preserves history when unchanged", () => {
    const summary = { id: "thread-1", turns: [] } as unknown as SessionDetail;
    const page = detail([turn("t1", "1")], "next");
    expect(mergeSessionHistory(summary, page, false)).toBe(page);
    const unchanged = { ...page, turns: [], historyPage: { nextCursor: null, version: "v1", unchanged: true } };
    expect(mergeSessionHistory(page, unchanged, false).turns).toEqual(page.turns);
    expect(mergeSessionHistory(page, unchanged, false).historyPage?.nextCursor).toBe("next");
  });
});
