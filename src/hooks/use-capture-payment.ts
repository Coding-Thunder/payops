"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import type { OrderDTO } from "@/types";

import { orderQueryKey } from "./use-order-query";

/** Both routes answer with the refreshed order under `{ order }`. */
interface OrderMutationResponse {
  order: OrderDTO;
}

interface CaptureVariables {
  /** Major units. Omit / null captures the full authorized amount. */
  amount?: number | null;
}

interface ReleaseVariables {
  /** Operator note written into the audit + evidence trail. Max 200 chars. */
  reason?: string | null;
}

export interface OrderPaymentMutationHandle<TVars> {
  /** Fires the mutation and resolves once the cache holds the new order.
   *  Rejects with the ApiClientError so the caller can toast the message. */
  run: (vars?: TVars) => Promise<OrderDTO>;
  isPending: boolean;
  error: string | null;
}

/**
 * Manual-capture money movement from the order detail page.
 *
 * Modelled on `use-reconcile-payment.ts`: the mutation writes the returned
 * order straight into the shared order query cache with
 * `setQueryData(orderQueryKey(orderId), data.order)`.
 *
 * `router.refresh()` is deliberately NOT used — the detail page renders
 * entirely from `useOrderQuery` and is handed no order by its server
 * component, so a refresh would re-render the same client tree against the
 * same cache and change nothing on screen.
 *
 * Neither hook is reachable for an automatic-capture order: the API refuses
 * it server-side, and the UI only mounts the controls when
 * `order.payment.capture` is non-null, which it never is for the two
 * incumbent brands.
 */
export function useCapturePayment(
  orderId: string,
): OrderPaymentMutationHandle<CaptureVariables> {
  const queryClient = useQueryClient();

  const mutation = useMutation<
    OrderMutationResponse,
    Error,
    CaptureVariables | undefined
  >({
    mutationFn: (vars) =>
      api.post<OrderMutationResponse>(`/api/orders/${orderId}/capture`, {
        amount: vars?.amount ?? null,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(orderQueryKey(orderId), data.order);
    },
  });

  return {
    run: async (vars) => (await mutation.mutateAsync(vars)).order,
    isPending: mutation.isPending,
    error: errorMessage(mutation.error),
  };
}

/**
 * Releases an authorization without charging. Same cache contract as
 * `useCapturePayment`.
 */
export function useReleaseAuthorization(
  orderId: string,
): OrderPaymentMutationHandle<ReleaseVariables> {
  const queryClient = useQueryClient();

  const mutation = useMutation<
    OrderMutationResponse,
    Error,
    ReleaseVariables | undefined
  >({
    mutationFn: (vars) =>
      api.post<OrderMutationResponse>(
        `/api/orders/${orderId}/cancel-authorization`,
        { reason: vars?.reason?.trim() || null },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(orderQueryKey(orderId), data.order);
    },
  });

  return {
    run: async (vars) => (await mutation.mutateAsync(vars)).order,
    isPending: mutation.isPending,
    error: errorMessage(mutation.error),
  };
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
