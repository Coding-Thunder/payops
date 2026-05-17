/**
 * Domain event registry. Every realtime push the platform emits has a type
 * defined here so producers (services, webhooks) and consumers (client
 * RealtimeProvider, activity feed) stay in lockstep.
 */

export const DomainEventType = {
  ORDER_CREATED: "order:created",
  ORDER_PAID: "order:paid",
  ORDER_FAILED: "order:failed",
  ORDER_EXPIRED: "order:expired",
  ORDER_ARCHIVED: "order:archived",
  ORDER_LINK_REGENERATED: "order:link_regenerated",

  USER_CREATED: "user:created",
  USER_UPDATED: "user:updated",

  SETTINGS_UPDATED: "settings:updated",
} as const;

export type DomainEventType =
  (typeof DomainEventType)[keyof typeof DomainEventType];

/**
 * Audience scoping rules — drives the SSE filter on the server.
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
  audience: DomainEventAudience;
  payload: TPayload;
}
