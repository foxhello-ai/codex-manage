import type { SessionDetail } from "../shared/models";

export function mergeSessionHistory(current: SessionDetail | null, incoming: SessionDetail, olderPage: boolean): SessionDetail {
  if (!incoming.historyPage || !current?.historyPage || current.id !== incoming.id) return incoming;
  if (incoming.historyPage.unchanged) return { ...incoming, turns: current.turns, historyPage: current.historyPage };
  const turns = new Map(current.turns.map(turn => [turn.id, turn]));
  if (!olderPage) for (const turn of incoming.turns) turns.set(turn.id, turn);
  // Server page order is authoritative, including when timestamps are absent or equal.
  const orderedIds = [...new Set((olderPage ? [...incoming.turns, ...current.turns] : [...current.turns, ...incoming.turns]).map(turn => turn.id))];
  for (const turn of incoming.turns) if (!turns.has(turn.id)) turns.set(turn.id, turn);
  return {
    ...incoming,
    turns: orderedIds.map(id => turns.get(id)!),
    historyPage: {
      ...incoming.historyPage,
      // Polling the latest page must not rewind the cursor after older pages were loaded.
      nextCursor: olderPage ? incoming.historyPage.nextCursor : current.historyPage?.nextCursor ?? null,
      version: olderPage ? current.historyPage?.version ?? null : incoming.historyPage.version
    }
  };
}
