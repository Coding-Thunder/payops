"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/common/page-header";
import { PageHeaderSkeleton } from "@/components/common/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { EmailComposer } from "@/components/features/orders/email-composer";
import { api, ApiClientError } from "@/lib/api-client";
import type { OrderDTO } from "@/types";

import { useWorkspaceStore } from "../store";
import { WorkspaceTabType } from "../types";

interface ComposeTabContentProps {
  tabId: string;
  orderId: string;
}

/**
 * Workspace-tab wrapper around the EmailComposer. Fetches the order
 * client-side via React Query and keeps the tab's label/subtitle in
 * sync with the loaded order number once it arrives.
 *
 * The initial preview HTML is left empty; the composer's own debounced
 * preview effect populates the iframe within ~350ms of mount. A
 * skeleton stands in for the iframe in the meantime.
 */
export function ComposeTabContent({ tabId, orderId }: ComposeTabContentProps) {
  // The /api/orders/[id] endpoint returns the OrderDTO directly (the
  // ApiResponse envelope is unwrapped in api-client). No `{ order }`
  // wrapper.
  const orderQuery = useQuery<OrderDTO>({
    queryKey: ["order", orderId],
    queryFn: () => api.get<OrderDTO>(`/api/orders/${orderId}`),
    enabled: !!orderId,
    staleTime: 30_000,
  });

  // Once the order resolves, push its number / customer name onto the
  // workspace tab so the tab strip reads "ORD-… · Email" instead of
  // "Order · Email".
  React.useEffect(() => {
    const order = orderQuery.data;
    if (!order) return;
    const store = useWorkspaceStore.getState();
    const tab = store.tabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== WorkspaceTabType.PAYMENT_COMPOSE) return;
    if (
      tab.payload.orderNumber === order.orderNumber &&
      tab.payload.customerName === order.customer.name
    ) {
      return;
    }
    store.updateTabMeta(tabId, {
      label: `${order.orderNumber} · Email`,
      subtitle: order.customer.name,
    });
  }, [orderQuery.data, tabId]);

  if (orderQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
          <Skeleton className="h-[820px]" />
          <Skeleton className="h-[860px]" />
        </div>
      </div>
    );
  }

  if (orderQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load order</AlertTitle>
        <AlertDescription>
          {orderQuery.error instanceof ApiClientError
            ? orderQuery.error.message
            : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  const order = orderQuery.data;
  if (!order) return null;

  // Default subject — same shape the server helper produces. Computed
  // client-side so the composer renders immediately without waiting on
  // an extra round-trip.
  const defaultSubject = `Complete your ${
    order.provider?.name ?? "rental"
  } payment • ${order.orderNumber}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Order"
        title="Send payment request"
        description="Edit the customer-facing email, then send when ready. The preview reflects exactly what will be delivered."
      />
      <EmailComposer
        order={order}
        initialHtml=""
        defaultSubject={defaultSubject}
      />
    </div>
  );
}
