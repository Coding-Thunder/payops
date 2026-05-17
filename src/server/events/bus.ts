import "server-only";

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  DomainEventType,
  type DomainEvent,
  type DomainEventAudience,
} from "@/lib/constants/events";
import { logger } from "@/lib/logger";

/**
 * In-memory event bus.
 *
 * NB: this is per-process. For multi-instance deployments swap the transport
 * for Redis pub/sub (or Ably/Pusher) — keep the same `publishEvent`/
 * `subscribeEvents` signature and only the implementation changes.
 *
 * The bus is mounted on `globalThis` so dev-mode HMR doesn't multiply the
 * listener count.
 */

type BusGlobal = typeof globalThis & { __payopsBus?: EventEmitter };

function getBus(): EventEmitter {
  const g = globalThis as BusGlobal;
  if (!g.__payopsBus) {
    const emitter = new EventEmitter();
    // Each SSE connection adds one listener; allow a generous ceiling.
    emitter.setMaxListeners(0);
    g.__payopsBus = emitter;
  }
  return g.__payopsBus;
}

interface PublishInput<TPayload extends Record<string, unknown>> {
  type: DomainEventType;
  payload: TPayload;
  audience: DomainEventAudience;
  actor?: DomainEvent["actor"];
}

const SYSTEM_ACTOR: DomainEvent["actor"] = {
  id: null,
  name: null,
  role: null,
};

export function publishEvent<TPayload extends Record<string, unknown>>(
  input: PublishInput<TPayload>,
): void {
  const event: DomainEvent<TPayload> = {
    type: input.type,
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: input.actor ?? SYSTEM_ACTOR,
    audience: input.audience,
    payload: input.payload,
  };
  try {
    getBus().emit("event", event);
  } catch (err) {
    logger.warn("events.publish_failed", {
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function subscribeEvents(
  handler: (event: DomainEvent) => void,
): () => void {
  const bus = getBus();
  bus.on("event", handler);
  return () => {
    bus.off("event", handler);
  };
}

/**
 * Determines whether a given event should be delivered to a session with
 * the supplied role/userId. Pure function — easy to unit-test.
 */
export function isEventVisibleToUser(
  event: DomainEvent,
  viewer: { userId: string; role: "SUPER_ADMIN" | "ADMIN" | "STAFF" },
): boolean {
  switch (event.audience.kind) {
    case "all":
      return true;
    case "admins":
      return viewer.role !== "STAFF";
    case "creator":
      if (event.audience.userId === viewer.userId) return true;
      return viewer.role !== "STAFF";
    default:
      return false;
  }
}
