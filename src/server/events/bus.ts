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
 * for Redis pub/sub (or Ably/Pusher), keep the same `publishEvent`/
 * `subscribeEvents` signature and only the implementation changes.
 *
 * The bus is mounted on `globalThis` so dev-mode HMR doesn't multiply the
 * listener count.
 */

type BusGlobal = typeof globalThis & { __tracetxnBus?: EventEmitter };

function getBus(): EventEmitter {
  const g = globalThis as BusGlobal;
  if (!g.__tracetxnBus) {
    const emitter = new EventEmitter();
    // Each SSE connection adds one listener; allow a generous ceiling.
    emitter.setMaxListeners(0);
    g.__tracetxnBus = emitter;
  }
  return g.__tracetxnBus;
}

interface PublishInput<TPayload extends Record<string, unknown>> {
  type: DomainEventType;
  payload: TPayload;
  audience: DomainEventAudience;
  actor?: DomainEvent["actor"];
  /** Tenant boundary. Required on every business-event publish so the
   *  SSE filter can keep Tenant A's events out of Tenant B's stream.
   *  Pass `null` ONLY for system-wide events that legitimately span
   *  tenants (currently: none, reserved for a future
   *  `platform:announcement` family). */
  orgId: string | null;
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
    orgId: input.orgId,
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
 * Determines whether a given event should be delivered to a session
 * with the supplied org / role / userId. Pure function, easy to
 * unit-test.
 *
 * Truth table (Pass 5a, closes the cross-tenant SSE bleed):
 *
 *   1. event.orgId === null         → "system" event. Apply the
 *                                     audience filter only (no tenant
 *                                     gate). Reserved for future
 *                                     platform-wide announcements; no
 *                                     such producer exists today.
 *   2. viewer.orgId === null        → viewer has no resolved org (a
 *                                     legacy un-migrated session).
 *                                     Deliver nothing.
 *   3. event.orgId !== viewer.orgId → cross-tenant. Deliver nothing.
 *   4. orgs match                   → fall through to the original
 *                                     audience-kind filter (all /
 *                                     admins / creator).
 *
 * Before this change `viewer.role !== "STAFF"` was enough for an
 * admin in Tenant A to see Tenant B's `order:created` event payload
 * over SSE, a real, exploitable cross-tenant leak. Documented in
 * the Phase-A audit risk #4.2.
 */
export function isEventVisibleToUser(
  event: DomainEvent,
  viewer: {
    userId: string;
    role: "SUPER_ADMIN" | "ADMIN" | "STAFF";
    /** Active organization id from the viewer's JWT (or
     *  `User.primaryOrgId` fallback). Null only for legacy tokens
     *  that haven't been re-issued post-migration. */
    orgId: string | null;
  },
): boolean {
  // Tenant gate first, runs before any audience-kind check.
  if (event.orgId !== null) {
    if (!viewer.orgId) return false;
    if (event.orgId !== viewer.orgId) return false;
  }
  // Tenant match (or system event), apply the audience filter.
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
