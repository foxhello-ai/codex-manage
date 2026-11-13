import type { SessionDetail, SessionTurn } from "../shared/models";

export function mergeDesktopTurns(persisted: SessionTurn[], desktop: SessionTurn[]): SessionTurn[] {
  const turns = new Map(persisted.map(turn => [turn.id, turn]));
  for (const turn of desktop) {
    const previous = turns.get(turn.id);
    // A delayed desktop poll must not reopen a durably completed turn.
    if (previous && ["completed", "failed", "interrupted"].includes(previous.status) && turn.status === "inProgress") continue;
    const items = new Map(previous?.items.map(item => [item.id, item]));
    for (const item of turn.items) items.set(item.id, item);
    turns.set(turn.id, { ...turn, items: [...items.values()] });
  }
  // Keep the durable order and place new live turns relative to shared anchors.
  const ids = persisted.map(turn => turn.id);
  for (const [index, turn] of desktop.entries()) {
    if (ids.includes(turn.id)) continue;
    const anchor = desktop.slice(index + 1).find(next => ids.includes(next.id));
    if (anchor) ids.splice(ids.indexOf(anchor.id), 0, turn.id);
    else ids.push(turn.id);
  }
  return ids.map(id => turns.get(id)!);
}

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
