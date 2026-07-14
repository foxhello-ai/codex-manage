import type { WebSessionEvent } from "../../shared/models";

type Subscriber = (event: WebSessionEvent) => void;

export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly events = new Map<string, WebSessionEvent[]>();
  private readonly nextSeq = new Map<string, number>();

  constructor(private readonly cacheLimit = 500) {}

  publish(threadId: string, type: WebSessionEvent["type"], payload: Record<string, unknown> = {}): WebSessionEvent {
    const seq = (this.nextSeq.get(threadId) ?? 1);
    this.nextSeq.set(threadId, seq + 1);

    const event: WebSessionEvent = {
      seq,
      threadId,
      type,
      payload,
      createdAt: new Date().toISOString()
    };

    const cached = this.events.get(threadId) ?? [];
    cached.push(event);
    if (cached.length > this.cacheLimit) cached.splice(0, cached.length - this.cacheLimit);
    this.events.set(threadId, cached);

    for (const subscriber of this.subscribers.get(threadId) ?? []) {
      subscriber(event);
    }

    return event;
  }

  subscribe(threadId: string, subscriber: Subscriber): () => void {
    const current = this.subscribers.get(threadId) ?? new Set<Subscriber>();
    current.add(subscriber);
    this.subscribers.set(threadId, current);

    return () => {
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(threadId);
    };
  }

  getEvents(threadId: string, afterSeq = 0): WebSessionEvent[] {
    return (this.events.get(threadId) ?? []).filter((event) => event.seq > afterSeq);
  }

  getLastSeq(threadId: string): number {
    return (this.nextSeq.get(threadId) ?? 1) - 1;
  }
}
