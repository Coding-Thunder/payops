"use client";

import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useActivityFeed } from "@/hooks/use-activity-feed";
import {
  DomainEventType,
  type DomainEvent,
} from "@/lib/constants/events";

import { useWorkspaceStore } from "../store";
import { WorkspaceTabType } from "../types";
import { orderQueryKey } from "./use-order-query";

/**
 * Bridge realtime domain events into per-tab React Query invalidations.
 *
 * The legacy realtime provider runs a debounced `router.refresh()` for
 * server-component re-renders. For client-side workspace tabs we need
 * the surgical equivalent: invalidate the query for the affected
 * orderId, but only if that order is actually open in some tab.
 *
 * Why care about "is it open"? Because invalidating a query for an order
 * the user isn't looking at would trigger a wasted fetch.
 */
export function useWorkspaceRealtime() {
  const queryClient = useQueryClient();
  const { events } = useActivityFeed();
  const lastSeenRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const newest = events[0];
    if (!newest) return;
    if (lastSeenRef.current === newest.id) return;

    // Walk every event newer than the last one we processed.
    const cutoffIdx = lastSeenRef.current
      ? events.findIndex((e) => e.id === lastSeenRef.current)
      : -1;
    const fresh =
      cutoffIdx === -1 ? events : events.slice(0, cutoffIdx);

    for (const event of fresh) {
      handleEvent(event, queryClient);
    }
    lastSeenRef.current = newest.id;
  }, [events, queryClient]);
}

function handleEvent(
  event: DomainEvent,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  const orderId =
    (event.payload as Record<string, unknown>).orderId as string | undefined;
  if (!orderId) return;

  // Only bother invalidating if some tab actually holds this order.
  const tabs = useWorkspaceStore.getState().tabs;
  const isOpen = tabs.some(
    (t) =>
      (t.type === WorkspaceTabType.ORDER_DETAILS ||
        t.type === WorkspaceTabType.PAYMENT_REVIEW) &&
      t.payload.orderId === orderId,
  );
  if (!isOpen) return;

  switch (event.type) {
    case DomainEventType.ORDER_PAID:
    case DomainEventType.ORDER_FAILED:
    case DomainEventType.ORDER_EXPIRED:
    case DomainEventType.ORDER_LINK_REGENERATED:
    case DomainEventType.ORDER_ARCHIVED:
      queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
      return;
    default:
      return;
  }
}
