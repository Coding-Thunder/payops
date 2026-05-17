"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { toast } from "@/components/ui/sonner";
import {
  ActivityFeedProvider,
  useActivityFeed,
} from "@/hooks/use-activity-feed";
import {
  DomainEventType,
  type DomainEvent,
} from "@/lib/constants/events";

/**
 * RealtimeProvider — wraps the authenticated layout with:
 *   1. An ActivityFeedProvider so any descendant can render the live feed.
 *   2. A single EventSource connection to /api/events.
 *   3. Side-effects per event: toast notifications + debounced
 *      router.refresh() so server components re-render with fresh data.
 *
 * Database is still the source of truth — events are notifications only.
 * `router.refresh()` triggers a Next.js server render, which re-fetches
 * from Mongo through the service layer.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ActivityFeedProvider>
      <RealtimeBridge />
      {children}
    </ActivityFeedProvider>
  );
}

function RealtimeBridge() {
  const router = useRouter();
  const { push } = useActivityFeed();
  const refreshTimer = React.useRef<number | null>(null);

  // Latest refs so the EventSource handler doesn't need to be reattached.
  const routerRef = React.useRef(router);
  const pushRef = React.useRef(push);
  React.useEffect(() => {
    routerRef.current = router;
    pushRef.current = push;
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
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

    const onEvent = (e: MessageEvent) => handle(e.data);
    source.addEventListener("payops", onEvent);

    source.onerror = () => {
      // EventSource auto-reconnects; we just log noisily in dev.
      if (process.env.NODE_ENV !== "production") {
         
        console.debug("[realtime] connection error - browser will reconnect");
      }
    };

    return () => {
      source.removeEventListener("payops", onEvent);
      source.close();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  return null;
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
