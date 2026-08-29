"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { toast } from "@/components/ui/sonner";
import {
  ActivityFeedProvider,
  useActivityFeed,
} from "@/hooks/use-activity-feed";
import {
  DomainEventType,
  ORDER_LIFECYCLE_EVENT_TYPES,
  type DomainEvent,
} from "@/lib/constants/events";
import { orderQueryKey } from "@/hooks/use-order-query";
import { useNotificationSound } from "@/components/providers/notification-sound-provider";
import type { NotificationTone } from "@/lib/notification-sound";

/**
 * Connection lifecycle exposed to the UI so a small chrome indicator can
 * surface what's happening without spamming toasts.
 *  - "connecting": initial socket open, no events received yet
 *  - "live":       socket is open and we've seen at least one ping/event
 *  - "reconnecting": socket dropped, browser is retrying
 *  - "offline":    user agent reports navigator.offline = true
 */
export type RealtimeStatus = "connecting" | "live" | "reconnecting" | "offline";

const RealtimeStatusContext = React.createContext<RealtimeStatus>("connecting");

export function useRealtimeStatus(): RealtimeStatus {
  return React.useContext(RealtimeStatusContext);
}

/**
 * RealtimeProvider — wraps the authenticated layout with:
 *   1. An ActivityFeedProvider so any descendant can render the live feed.
 *   2. A single EventSource connection to /api/events.
 *   3. Side-effects per event: toast notifications + debounced
 *      router.refresh() so server components re-render with fresh data.
 *   4. A connection status context for tiny chrome indicators.
 *
 * Database is still the source of truth — events are notifications only.
 * `router.refresh()` triggers a Next.js server render, which re-fetches
 * from Mongo through the service layer.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting");
  return (
    <ActivityFeedProvider>
      <RealtimeBridge onStatusChange={setStatus} />
      <RealtimeStatusContext.Provider value={status}>
        {children}
      </RealtimeStatusContext.Provider>
    </ActivityFeedProvider>
  );
}

function RealtimeBridge({
  onStatusChange,
}: {
  onStatusChange: (s: RealtimeStatus) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { push } = useActivityFeed();
  const { play } = useNotificationSound();
  const refreshTimer = React.useRef<number | null>(null);

  // Latest refs so the EventSource handler doesn't need to be reattached.
  const routerRef = React.useRef(router);
  const queryClientRef = React.useRef(queryClient);
  const pushRef = React.useRef(push);
  const statusRef = React.useRef(onStatusChange);
  const playRef = React.useRef(play);
  React.useEffect(() => {
    routerRef.current = router;
    queryClientRef.current = queryClient;
    pushRef.current = push;
    statusRef.current = onStatusChange;
    playRef.current = play;
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    function syncOnline() {
      if (!navigator.onLine) statusRef.current("offline");
    }
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);

    const source = new EventSource("/api/events");

    const handle = (data: string) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(data) as DomainEvent;
      } catch {
        return;
      }
      pushRef.current(event);
      notifyForEvent(event);
      // Same pass as the toast, so a sound can never disagree with what is
      // on screen. `resolveEventTone` returns null for quiet event types and
      // for anything it considers a duplicate.
      const tone = resolveEventTone(event);
      if (tone) playRef.current(tone);
      // Per-order lifecycle events: invalidate the React Query cache for
      // the specific orderId so any mounted <OrderDetail /> refetches
      // immediately. router.refresh() below covers server components
      // (orders list, etc.) — this covers the client-side cached query.
      if (ORDER_LIFECYCLE_EVENT_TYPES.has(event.type)) {
        const orderId =
          (event.payload as { orderId?: string } | undefined)?.orderId ?? null;
        if (orderId) {
          queryClientRef.current.invalidateQueries({
            queryKey: orderQueryKey(orderId),
            exact: true,
          });
        }
        // Listing endpoints (orders list, at-risk, activity feed) all
        // pivot off the orders collection — drop any cached page so the
        // table re-fetches on next mount/scroll.
        queryClientRef.current.invalidateQueries({
          queryKey: ["orders"],
        });
      }
      scheduleRefresh();
    };

    function scheduleRefresh() {
      if (refreshTimer.current) {
        window.clearTimeout(refreshTimer.current);
      }
      refreshTimer.current = window.setTimeout(() => {
        routerRef.current.refresh();
        refreshTimer.current = null;
      }, 350);
    }

    source.onopen = () => {
      statusRef.current(navigator.onLine ? "live" : "offline");
    };

    const onEvent = (e: MessageEvent) => {
      // Any inbound traffic means the socket is open and useful.
      statusRef.current("live");
      handle(e.data);
    };
    source.addEventListener("payops", onEvent);

    source.onerror = () => {
      // EventSource auto-reconnects; surface that state to the UI.
      if (source.readyState === EventSource.CLOSED) {
        statusRef.current("offline");
      } else {
        statusRef.current(navigator.onLine ? "reconnecting" : "offline");
      }
      if (process.env.NODE_ENV !== "production") {
        console.debug("[realtime] connection error - browser will reconnect");
      }
    };

    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
      source.removeEventListener("payops", onEvent);
      source.close();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  return null;
}

/**
 * Which business events are worth a sound.
 *
 * Deliberately a SUBSET of the events that raise a toast. Anything the
 * operator themselves just did (sending an email, regenerating a link) is
 * silent — they are looking at the screen and do not need to be told. Sound
 * is reserved for things that arrive on their own.
 *
 * `null` means "notify visually, but stay quiet".
 */
const EVENT_TONE: Partial<Record<DomainEventType, NotificationTone | null>> = {
  [DomainEventType.ORDER_CREATED]: "order",
  [DomainEventType.ORDER_AUTHORIZED]: "authorized",
  [DomainEventType.ORDER_PAID]: "paid",
  [DomainEventType.ORDER_FAILED]: "failed",
  [DomainEventType.ORDER_REFUNDED]: "refunded",
  [DomainEventType.ORDER_DISPUTE_CREATED]: "dispute",
  // Deliberately silent: operator-initiated, mid-life, or purely
  // informational. They still toast and still update the feed.
  [DomainEventType.ORDER_EMAIL_SENT]: null,
  [DomainEventType.ORDER_LINK_REGENERATED]: null,
  [DomainEventType.ORDER_CONSENT_RECEIVED]: null,
  [DomainEventType.ORDER_CONFIRMATION_SENT]: null,
  [DomainEventType.ORDER_DISPUTE_UPDATED]: null,
  [DomainEventType.ORDER_EXPIRED]: null,
  [DomainEventType.ORDER_AUTHORIZATION_RELEASED]: null,
};

/**
 * A capture produces ORDER_PAID (the shared applyCheckoutPaid transition) and
 * is conceptually the "captured" moment for a manual-capture order. The
 * payload carries no capture flag, so the tone is chosen by whether the order
 * was previously authorized — tracked below.
 */
const AUTHORIZED_ORDERS = new Set<string>();

/**
 * Suppression window for the SAME business event on the SAME order.
 *
 * The server already dedupes hard: `tryClaimGatewayEvent` claims each gateway
 * event id against a unique index, and `publishEvent` only fires inside
 * `if (outcome.didTransition)`, so a replayed Stripe webhook does not emit a
 * second domain event. This is the CLIENT-side backstop for the cases that
 * guard cannot see:
 *
 *   - the webhook and the reconcile endpoint racing on one order, which use
 *     deliberately disjoint dedupe keys (`evt_…` vs `reconcile:…`) so both
 *     can legitimately claim before one loses the status guard,
 *   - an EventSource reconnect redelivering recent events,
 *   - two browser tabs, each with its own connection.
 *
 * Keyed on type+orderId rather than event id, because the point is one sound
 * per BUSINESS event, and those three cases produce different ids for the
 * same business fact.
 */
const SOUND_DEDUPE_MS = 4000;
const recentSounds = new Map<string, number>();

/** Exact-id dedupe, for a literal redelivery of the same emission. */
const seenEventIds = new Map<string, number>();
const ID_DEDUPE_MS = 60_000;

function prune(map: Map<string, number>, ttl: number, now: number) {
  if (map.size < 64) return;
  for (const [k, t] of map) if (now - t > ttl) map.delete(k);
}

/**
 * Decide whether this event should make a sound, and which. Returns null when
 * it should be silent — either because the event type is quiet, or because it
 * is a duplicate of one we just played.
 */
export function resolveEventTone(event: DomainEvent): NotificationTone | null {
  const now = Date.now();

  // 1. Literal redelivery of the same emission.
  if (seenEventIds.has(event.id)) return null;
  seenEventIds.set(event.id, now);
  prune(seenEventIds, ID_DEDUPE_MS, now);

  let tone = EVENT_TONE[event.type];
  if (tone === undefined || tone === null) return null;

  const orderId =
    (event.payload as { orderId?: string } | undefined)?.orderId ?? "";

  // 2. A manual-capture order that was authorized first gets the distinct
  //    "captured" tone when it later becomes PAID, so capture is audibly
  //    different from a straight-through payment.
  if (event.type === DomainEventType.ORDER_AUTHORIZED && orderId) {
    AUTHORIZED_ORDERS.add(orderId);
  }
  if (
    event.type === DomainEventType.ORDER_PAID &&
    orderId &&
    AUTHORIZED_ORDERS.has(orderId)
  ) {
    tone = "captured";
    AUTHORIZED_ORDERS.delete(orderId);
  }

  // 3. Same business event on the same order inside the window.
  const key = `${event.type}:${orderId}`;
  const last = recentSounds.get(key);
  if (last !== undefined && now - last < SOUND_DEDUPE_MS) return null;
  recentSounds.set(key, now);
  prune(recentSounds, SOUND_DEDUPE_MS, now);

  return tone;
}

/** Test seam: clear dedupe state between cases. */
export function _resetNotificationDedupe(): void {
  recentSounds.clear();
  seenEventIds.clear();
  AUTHORIZED_ORDERS.clear();
}

function notifyForEvent(event: DomainEvent) {
  const p = event.payload as Record<string, unknown>;
  const orderNumber = (p.orderNumber as string | undefined) ?? undefined;
  const customerName = (p.customerName as string | undefined) ?? undefined;
  const subject = orderNumber ?? customerName ?? "Update";

  switch (event.type) {
    case DomainEventType.ORDER_PAID:
      toast.success("Payment received", {
        description: `${subject}${customerName ? ` · ${customerName}` : ""}`,
      });
      return;
    case DomainEventType.ORDER_CONSENT_RECEIVED:
      toast.success("Consent received", {
        description: `${subject}${customerName ? ` · ${customerName}` : ""}`,
      });
      return;
    case DomainEventType.ORDER_EMAIL_SENT:
      // Quiet by default — the agent triggered this, they don't need a
      // toast on top of the in-page success state. The cache invalidation
      // alone is enough to flip the timeline.
      return;
    case DomainEventType.ORDER_CONFIRMATION_SENT:
      toast.success("Confirmation email sent", { description: subject });
      return;
    case DomainEventType.ORDER_DISPUTE_CREATED:
      toast.error("Chargeback opened", {
        description: `${subject}${
          p.reason ? ` · ${String(p.reason).slice(0, 80)}` : ""
        }`,
      });
      return;
    case DomainEventType.ORDER_DISPUTE_UPDATED:
      // Quieter than created — only the at-risk dashboard cares about
      // mid-life status changes. The cache invalidation handles the
      // visible refresh.
      return;
    case DomainEventType.ORDER_DISPUTE_CLOSED:
      toast(
        p.outcome === "WON"
          ? "Dispute won"
          : p.outcome === "LOST"
            ? "Dispute lost"
            : "Dispute closed",
        { description: subject },
      );
      return;
    case DomainEventType.ORDER_REFUNDED:
      toast("Refund processed", {
        description: `${subject}${
          typeof p.amount === "number"
            ? ` · ${p.amount} ${p.currency ?? ""}`
            : ""
        }`,
      });
      return;
    case DomainEventType.ORDER_FAILED:
      toast.error("Payment failed", {
        description: `${subject}${
          p.reason ? ` · ${String(p.reason).slice(0, 80)}` : ""
        }`,
      });
      return;
    case DomainEventType.ORDER_EXPIRED:
      toast.warning("Payment link expired", { description: subject });
      return;
    case DomainEventType.ORDER_CREATED:
      toast("Order created", { description: subject });
      return;
    case DomainEventType.ORDER_LINK_REGENERATED:
      toast("New payment link generated", { description: subject });
      return;
    case DomainEventType.ORDER_ARCHIVED:
      toast("Order archived", { description: subject });
      return;
    case DomainEventType.USER_CREATED:
      toast("Team member added", {
        description: (p.name as string) ?? "",
      });
      return;
    case DomainEventType.USER_UPDATED:
      toast("Team member updated", {
        description: (p.name as string) ?? "",
      });
      return;
    default:
      return;
  }
}
