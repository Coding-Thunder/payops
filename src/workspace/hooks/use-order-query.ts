"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import type { OrderDTO } from "@/types";

export const orderQueryKey = (orderId: string) =>
  ["workspace", "order", orderId] as const;

/**
 * Fetch a single order by id. Each tab calls this independently — React
 * Query dedupes the network request via the shared key, so opening the
 * same order in multiple tabs still hits the API once.
 */
export function useOrderQuery(orderId: string): UseQueryResult<OrderDTO> {
  return useQuery({
    queryKey: orderQueryKey(orderId),
    queryFn: () => api.get<OrderDTO>(`/api/orders/${orderId}`),
    // Background tabs shouldn't poll — realtime events drive invalidation.
    refetchInterval: false,
    staleTime: 30_000,
  });
}
