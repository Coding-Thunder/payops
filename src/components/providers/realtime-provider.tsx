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
  const { push } = useActivityFeed();
  const refreshTimer = React.useRef<number | null>(null);

  // Latest refs so the EventSource handler doesn't need to be reattached.
  const routerRef = React.useRef(router);
  const pushRef = React.useRef(push);
  const statusRef = React.useRef(onStatusChange);
  React.useEffect(() => {
    routerRef.current = router;
    pushRef.current = push;
    statusRef.current = onStatusChange;
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
