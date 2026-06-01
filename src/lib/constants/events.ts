/**
 * Domain event registry. Every realtime push the platform emits has a type
 * defined here so producers (services, webhooks) and consumers (client
 * RealtimeProvider, activity feed) stay in lockstep.
 */

export const DomainEventType = {
  ORDER_CREATED: "order:created",
  ORDER_EMAIL_SENT: "order:email_sent",
  ORDER_CONSENT_RECEIVED: "order:consent_received",
  ORDER_PAID: "order:paid",
  ORDER_CONFIRMATION_SENT: "order:confirmation_sent",
  ORDER_FAILED: "order:failed",
  ORDER_EXPIRED: "order:expired",
  ORDER_ARCHIVED: "order:archived",
  ORDER_LINK_REGENERATED: "order:link_regenerated",
  ORDER_DISPUTE_CREATED: "order:dispute_created",
  ORDER_DISPUTE_UPDATED: "order:dispute_updated",
  ORDER_DISPUTE_CLOSED: "order:dispute_closed",
  ORDER_REFUNDED: "order:refunded",

  USER_CREATED: "user:created",
  USER_UPDATED: "user:updated",

  SETTINGS_UPDATED: "settings:updated",
} as const;

/**
 * The set of event types whose payload references a specific orderId. The
 * client uses this to know when to invalidate the per-order React Query
 * cache, adding a new order:* event? Add it here too.
 */
export const ORDER_LIFECYCLE_EVENT_TYPES = new Set<string>([
  "order:created",
  "order:email_sent",
  "order:consent_received",
  "order:paid",
  "order:confirmation_sent",
  "order:failed",
  "order:expired",
  "order:archived",
  "order:link_regenerated",
  "order:dispute_created",
  "order:dispute_updated",
  "order:dispute_closed",
  "order:refunded",
]);

export type DomainEventType =
  (typeof DomainEventType)[keyof typeof DomainEventType];

/**
 * Audience scoping rules, drives the SSE filter on the server.
 *  - `all`     : visible to everyone with an active session
 *  - `admins`  : ADMIN + SUPER_ADMIN only
 *  - `creator` : the user who created the underlying record (plus admins)
 */
export type DomainEventAudience =
  | { kind: "all" }
  | { kind: "admins" }
  | { kind: "creator"; userId: string };

export interface DomainEvent<TPayload = Record<string, unknown>> {
  type: DomainEventType;
  /** Unique per emission, used by clients for de-dup. */
  id: string;
  /** ISO timestamp on the server when the event was emitted. */
  at: string;
  /** Who triggered the event (or null for system / webhook). */
  actor: {
    id: string | null;
    name: string | null;
    role: "SUPER_ADMIN" | "ADMIN" | "STAFF" | null;
  };
  /** Tenant boundary on the event. Required for any event scoped to a
   *  business record; nullable only for system-wide events that have
   *  no tenant context (rare, at the time of writing, none).
   *
   *  The SSE filter (`isEventVisibleToUser`) gates delivery on this:
   *  viewers only see events whose `orgId` matches their own active
   *  org. An event with no `orgId` (legacy + system) is treated as
   *  "scope unknown" and delivered ONLY when the audience-kind filter
   *  also passes, see the comment in `bus.ts` for the truth table. */
  orgId: string | null;
  audience: DomainEventAudience;
  payload: TPayload;
}
