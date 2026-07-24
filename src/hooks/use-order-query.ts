"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { ConsentStatus, OrderStatus } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

export const orderQueryKey = (orderId: string) =>
  ["order", orderId] as const;

/** While an order is in a non-terminal lifecycle state (link generated,
 *  payment pending, or awaiting confirmation email after PAID) poll on
 *  an interval so a missed SSE event or a webhook that never landed
 *  (local dev without `stripe listen`, proxy-buffered SSE) still
 *  surfaces in the UI within a single tick. SSE invalidation remains
 *  the primary push, polling is the backstop. */
const NON_TERMINAL_POLL_MS = 6_000;
/** PAID-but-confirmation-pending is a much shorter window, typically
 *  a single SMTP round-trip, so poll faster to avoid users staring at
 *  "Sending receipt" past the moment the email actually went out. */
const CONFIRMATION_POLL_MS = 4_000;

export interface UseOrderQueryOptions {
  /** Backstop polling for non-terminal orders. On by default (the order
   *  detail page relies on it to reflect webhook-driven status changes).
   *  Screens that only *compose* against a frozen order — e.g. the email
   *  composer — pass `false`: they navigate away on send and don't need a
   *  6s poll, and leaving it on made the composer's live-preview effect
   *  re-fire a `/payment-request-preview` on every tick (a request
   *  storm). */
  poll?: boolean;
}

/**
 * Client-side fetch for a single order by id. The order detail route is
 * the canonical caller, the page mounts it, the iframe-preview path on
 * the email composer reads from it too. React Query dedupes the
 * underlying network request via the shared key.
 */
export function useOrderQuery(
  orderId: string,
  options: UseOrderQueryOptions = {},
): UseQueryResult<OrderDTO> {
  const { poll = true } = options;
  return useQuery({
    queryKey: orderQueryKey(orderId),
    queryFn: () => api.get<OrderDTO>(`/api/orders/${orderId}`),
    refetchInterval: (query) => {
      if (!poll) return false;
      const order = query.state.data;
      if (!order) return false;
      const status = order.status;
      // Any non-terminal status with a customer in the loop deserves a
      // polling backstop.
      if (
        status === OrderStatus.LINK_GENERATED ||
        status === OrderStatus.PAYMENT_PENDING
      ) {
        return NON_TERMINAL_POLL_MS;
      }
      // PAID but the confirmation email hasn't been recorded yet, poll
      // briefly so the timeline's final node flips without a refresh.
      if (
        status === OrderStatus.PAID &&
        !order.payment.confirmationEmailSentAt
      ) {
        return CONFIRMATION_POLL_MS;
      }
      // Customer was asked but hasn't replied, keep checking the
      // consent pointer in case the backend missed the realtime push.
      if (
        order.consent?.status === ConsentStatus.REQUESTED &&
        status !== OrderStatus.PAID &&
        status !== OrderStatus.FAILED &&
        status !== OrderStatus.EXPIRED
      ) {
        return NON_TERMINAL_POLL_MS;
      }
      return false;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}
