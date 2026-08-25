"use client";

import { useRouter } from "next/navigation";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import type { FileFilter, LinkFilter } from "@/lib/constants/client-resources";
import type { ClientFileDTO, ClientLinkDTO } from "@/types";

/**
 * Files & Links reads.
 *
 * The query key carries the full scope (client, order, filter, search)
 * so the Client Files tab and an Order Files card can be mounted at the
 * same time without stepping on each other's cache — they're different
 * views of the same collection, and they must be able to disagree about
 * which slice they're showing while agreeing about the underlying rows.
 *
 * `invalidateResources` is the single write-side hook: after any
 * mutation, every scope is refetched. That is deliberately blunt —
 * relating a file to an order changes what BOTH the client list and the
 * order list should show, and reasoning about which keys those are is
 * more code than simply refetching two cheap lists.
 */

export interface ResourceScope {
  customerId?: string;
  orderId?: string;
  q?: string;
}

export interface FilesScope extends ResourceScope {
  filter?: FileFilter;
}

export interface LinksScope extends ResourceScope {
  filter?: LinkFilter;
}

function toQueryString(scope: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const clientFilesKey = (scope: FilesScope) =>
  ["client-files", scope.customerId ?? null, scope.orderId ?? null, scope.filter ?? "all", scope.q ?? ""] as const;

export function useClientFiles(
  scope: FilesScope,
  enabled = true,
): UseQueryResult<ClientFileDTO[]> {
  return useQuery({
    queryKey: clientFilesKey(scope),
    enabled: enabled && Boolean(scope.customerId || scope.orderId),
    queryFn: async () => {
      const data = await api.get<{ files: ClientFileDTO[] }>(
        `/api/files${toQueryString({
          customerId: scope.customerId,
          orderId: scope.orderId,
          filter: scope.filter,
          q: scope.q,
        })}`,
      );
      return data.files;
    },
  });
}

export const clientLinksKey = (scope: LinksScope) =>
  ["client-links", scope.customerId ?? null, scope.orderId ?? null, scope.filter ?? "all", scope.q ?? ""] as const;

export function useClientLinks(
  scope: LinksScope,
  enabled = true,
): UseQueryResult<ClientLinkDTO[]> {
  return useQuery({
    queryKey: clientLinksKey(scope),
    enabled: enabled && Boolean(scope.customerId || scope.orderId),
    queryFn: async () => {
      const data = await api.get<{ links: ClientLinkDTO[] }>(
        `/api/links${toQueryString({
          customerId: scope.customerId,
          orderId: scope.orderId,
          filter: scope.filter,
          q: scope.q,
        })}`,
      );
      return data.links;
    },
  });
}

/**
 * Refetch every Files/Links view after a write.
 *
 * Two layers, because two things render this data: the React Query
 * caches behind the panels, and the SERVER-rendered pieces of the client
 * profile — the "Files (3)" tab counts and the Timeline. Without the
 * `router.refresh()` an upload would appear in the list while the tab
 * beside it still said the old number.
 */
export function useInvalidateResources() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["client-files"] });
    void queryClient.invalidateQueries({ queryKey: ["client-links"] });
    router.refresh();
  };
}
