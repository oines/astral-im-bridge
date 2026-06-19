import { randomUUID } from "node:crypto";
import { error, log } from "./logger.js";
import type { ExternalEvent, ExternalEventsConfig } from "./types.js";

export interface ExternalEventBatchStatus {
  pendingEvents: number;
  droppedEvents: number;
  debounceMs: number;
  maxBatchEvents: number;
  maxBatchBodyChars: number;
  nextFlushAt: string | null;
}

export interface ExternalEventBatchResult {
  pendingEvents: number;
  droppedEvents: number;
  debounceMs: number;
  maxBatchEvents: number;
  maxBatchBodyChars: number;
  nextFlushAt: string;
}

type SubmitEvent = (event: ExternalEvent) => Promise<void>;

export class ExternalEventBatcher {
  private pending: ExternalEvent[] = [];
  private droppedEvents = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextFlushAtMs: number | null = null;

  constructor(
    private readonly config: ExternalEventsConfig,
    private readonly submitEvent: SubmitEvent,
  ) {}

  enqueue(event: ExternalEvent): ExternalEventBatchResult {
    if (this.pending.length < this.config.maxBatchEvents) {
      this.pending.push(event);
    } else {
      this.droppedEvents += 1;
    }

    if (!this.timer) {
      this.nextFlushAtMs = Date.now() + this.config.debounceMs;
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.config.debounceMs);
    }

    const nextFlushAtMs = this.nextFlushAtMs ?? Date.now();
    return {
      pendingEvents: this.pending.length,
      droppedEvents: this.droppedEvents,
      debounceMs: this.config.debounceMs,
      maxBatchEvents: this.config.maxBatchEvents,
      maxBatchBodyChars: this.config.maxBatchBodyChars,
      nextFlushAt: new Date(nextFlushAtMs).toISOString(),
    };
  }

  status(): ExternalEventBatchStatus {
    return {
      pendingEvents: this.pending.length,
      droppedEvents: this.droppedEvents,
      debounceMs: this.config.debounceMs,
      maxBatchEvents: this.config.maxBatchEvents,
      maxBatchBodyChars: this.config.maxBatchBodyChars,
      nextFlushAt: this.nextFlushAtMs == null ? null : new Date(this.nextFlushAtMs).toISOString(),
    };
  }

  private async flush(): Promise<void> {
    const events = this.pending;
    const droppedEvents = this.droppedEvents;
    this.pending = [];
    this.droppedEvents = 0;
    this.timer = null;
    this.nextFlushAtMs = null;

    if (events.length === 0) {
      return;
    }

    const batchedEvent = buildBatchEvent(events, droppedEvents, this.config.maxBatchBodyChars);
    log("forwarding external event batch to astral", {
      eventCount: events.length,
      droppedEvents,
      eventId: batchedEvent.id,
      source: batchedEvent.source,
      eventType: batchedEvent.eventType,
    });

    try {
      await this.submitEvent(batchedEvent);
    } catch (err) {
      error("failed to forward external event batch", {
        eventCount: events.length,
        droppedEvents,
        error: String(err),
      });
    }
  }
}

function buildBatchEvent(
  events: ExternalEvent[],
  droppedEvents: number,
  maxBodyChars: number,
): ExternalEvent {
  if (events.length === 1 && droppedEvents === 0) {
    return truncateSingleEvent(events[0], maxBodyChars);
  }

  const sources = countBy(events, (event) => event.source);
  const eventTypes = countBy(events, (event) => event.eventType);
  const source = Object.keys(sources).length === 1 ? events[0].source : "multiple";
  const body = renderBatchBody(events, droppedEvents, maxBodyChars);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    source,
    eventType: "batch",
    title: `Batched external events (${events.length}${droppedEvents ? ` + ${droppedEvents} omitted` : ""})`,
    body: body.text,
    severity: batchSeverity(events),
    actor: null,
    metadata: {
      bridgeBatch: {
        includedEventCount: events.length,
        droppedEventCount: droppedEvents,
        bodyTruncatedChars: body.truncatedChars,
        firstEventId: events[0].id,
        lastEventId: events.at(-1)?.id ?? events[0].id,
        windowStartedAt: events[0].receivedAt,
        windowEndedAt: events.at(-1)?.receivedAt ?? events[0].receivedAt,
        sources,
        eventTypes,
      },
    },
    dedupeKey: null,
    occurredAt: events[0].occurredAt,
    receivedAt: now,
  };
}

function truncateSingleEvent(event: ExternalEvent, maxBodyChars: number): ExternalEvent {
  const body = truncateText(event.body, maxBodyChars);
  if (body.truncatedChars === 0) {
    return event;
  }
  return {
    ...event,
    body: body.text,
    metadata: {
      ...event.metadata,
      bridgeBatch: {
        bodyTruncatedChars: body.truncatedChars,
      },
    },
  };
}

function renderBatchBody(
  events: ExternalEvent[],
  droppedEvents: number,
  maxBodyChars: number,
): { text: string; truncatedChars: number } {
  const rendered = events.map((event, index) => renderEventSummary(event, index)).join("\n\n");
  const suffix = droppedEvents > 0
    ? `\n\n[bridge omitted ${droppedEvents} additional events beyond maxBatchEvents]`
    : "";
  return truncateText(`${rendered}${suffix}`, maxBodyChars);
}

function renderEventSummary(event: ExternalEvent, index: number): string {
  const lines = [
    `#${index + 1} ${event.source}/${event.eventType}`,
    `event_id: ${event.id}`,
    `severity: ${event.severity}`,
    `occurred_at: ${event.occurredAt}`,
  ];
  if (event.title) {
    lines.push(`title: ${event.title}`);
  }
  if (event.actor != null) {
    lines.push(`actor: ${truncateInline(JSON.stringify(event.actor), 500)}`);
  }
  if (Object.keys(event.metadata).length > 0) {
    lines.push(`metadata: ${truncateInline(JSON.stringify(event.metadata), 500)}`);
  }
  lines.push("body:");
  lines.push(event.body);
  return lines.join("\n");
}

function truncateText(text: string, maxChars: number): { text: string; truncatedChars: number } {
  if (text.length <= maxChars) {
    return { text, truncatedChars: 0 };
  }
  const suffix = `\n\n[bridge truncated ${text.length - maxChars} chars to keep this event batch bounded]`;
  const budget = Math.max(maxChars - suffix.length, 0);
  return {
    text: `${text.slice(0, budget)}${suffix.slice(0, maxChars - budget)}`,
    truncatedChars: text.length - maxChars,
  };
}

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(maxChars - 16, 0))}...[truncated]`;
}

function countBy(events: ExternalEvent[], key: (event: ExternalEvent) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const value = key(event);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function batchSeverity(events: ExternalEvent[]): string {
  const order = ["critical", "fatal", "error", "warn", "warning", "info", "debug", "trace"];
  let bestIndex = order.length;
  let best = events[0]?.severity ?? "info";
  for (const event of events) {
    const index = order.indexOf(event.severity.toLowerCase());
    if (index !== -1 && index < bestIndex) {
      bestIndex = index;
      best = event.severity;
    }
  }
  return best;
}
