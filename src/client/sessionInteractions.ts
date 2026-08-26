import type { SessionTurn } from "../shared/models";
import { stripAmbientBrowserContext } from "../shared/messageText";

type SendShortcutInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
};

export type RetryContext = {
  messageId: string;
  turnId: string | null;
  text: string;
};

export type RetryMessageCandidate = {
  id: string;
  role: "user" | "agent";
  turnId: string | null;
  text: string;
};

export function isTaskSendShortcut(event: SendShortcutInput): boolean {
  return event.key === "Enter" && !event.repeat && (event.ctrlKey || event.metaKey);
}

/**
 * Returns the user message that belongs to one exact runtime turn.  A terminal
 * error must never borrow a message from another attempt simply because it was
 * the most recent user message on screen.
 */
export function findRetryContextForTurn(
  turnId: string | null,
  liveMessages: readonly RetryMessageCandidate[],
  turns: readonly SessionTurn[]
): RetryContext | null {
  if (!turnId) return null;

  const liveMessage = [...liveMessages]
    .reverse()
    .map((message) => ({ ...message, text: stripAmbientBrowserContext(message.text) }))
    .find((message) => message.role === "user" && message.turnId === turnId && message.text.trim().length > 0);
  if (liveMessage) return { messageId: liveMessage.id, turnId, text: liveMessage.text };

  const turn = turns.find((item) => item.id === turnId);
  if (!turn) return null;
  const historyMessage = [...turn.items]
    .reverse()
    .map((item) => item.type === "user_message" ? { ...item, text: stripAmbientBrowserContext(item.text) } : item)
    .find((item) => item.type === "user_message" && item.text.trim().length > 0);
  return historyMessage && historyMessage.type === "user_message"
    ? { messageId: historyMessage.id, turnId: turn.id, text: historyMessage.text }
    : null;
}

/** Restore the newest failed attempt after a detail-page refresh. */
export function findRetryContextFromFailedTurns(turns: readonly SessionTurn[]): RetryContext | null {
  for (const turn of [...turns].reverse()) {
    if (turn.status !== "failed" && !turn.error) continue;
    const context = findRetryContextForTurn(turn.id, [], turns);
    if (context) return context;
  }
  return null;
}
