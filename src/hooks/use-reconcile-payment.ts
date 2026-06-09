"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { api } from "@/lib/api-client";
import { OrderStatus } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

import { orderQueryKey } from "./use-order-query";

interface ReconcileResponse {
  order: OrderDTO;
  changed: boolean;
  stripeStatus:
    | "paid"
    | "unpaid"
    | "no_payment_required"
    | "expired"
    | "open"
    | "unknown";
}

interface UseReconcilePaymentArgs {
  orderId: string;
  /** Current cached status, drives whether we auto-trigger once. */
  status: string | undefined;
  /** True iff the order has a Stripe session id to reconcile against.
   *  Auto-trigger is skipped without one. */
  hasSession: boolean;
}

interface ReconcileHandle {
  /** Manual button trigger. Always safe, the service short-circuits if
   *  the order is already terminal. */
  trigger: () => void;
  isReconciling: boolean;
  lastResult: ReconcileResponse | null;
  error: string | null;
}

/**
 * Reconcile-on-demand for the order detail page.
 *
 *   - Auto-triggers ONCE per mount, ~2.5 s after the page opens, but only
 *     when the order is PAYMENT_PENDING and has a Stripe session id.
 *     This covers the local-dev case where the webhook never reaches
 *     localhost (no `stripe listen` forwarder), the agent doesn't need
 *     to click anything; the UI self-heals shortly after navigation.
 *   - Exposes a manual `trigger()` for the explicit "Check payment with
 *     Stripe" button (where applicable).
 *   - Invalidates the order query on success so the page rerenders the
 *     refreshed state immediately.
 */
export function useReconcilePayment({
  orderId,
  status,
  hasSession,
}: UseReconcilePaymentArgs): ReconcileHandle {
  const queryClient = useQueryClient();
  const autoFiredRef = React.useRef(false);

  const mutation = useMutation<ReconcileResponse, Error, void>({
    mutationFn: () =>
      api.post<ReconcileResponse>(`/api/orders/${orderId}/reconcile`),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
      queryClient.setQueryData(orderQueryKey(orderId), data.order);
    },
  });

  React.useEffect(() => {
    if (autoFiredRef.current) return;
    // Cover both LINK_GENERATED (link out, customer can pay via the
    // hosted consent → Stripe flow before our email send completes)
    // and PAYMENT_PENDING (email out). The reconcile service is a
    // no-op when Stripe says the session is still open, so firing on
    // either status is safe.
    if (
      status !== OrderStatus.PAYMENT_PENDING &&
      status !== OrderStatus.LINK_GENERATED
    ) {
      return;
    }
    if (!hasSession) return;
    autoFiredRef.current = true;
    const t = window.setTimeout(() => {
      mutation.mutate();
    }, 2_500);
    return () => window.clearTimeout(t);
    // Intentional: run only when the status first becomes pending on
    // mount. We don't want a re-fire when the user manually triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, hasSession]);

  return {
    trigger: () => mutation.mutate(),
    isReconciling: mutation.isPending,
    lastResult: mutation.data ?? null,
    error:
      mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? String(mutation.error)
          : null,
  };
}
