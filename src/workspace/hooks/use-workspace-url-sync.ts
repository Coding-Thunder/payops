"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { useWorkspaceStore } from "../store";
import {
  isWorkspaceRoute,
  tabMatchesUrl,
  tabUrlFor,
  WorkspaceTabType,
  type WorkspaceTab,
} from "../types";

/**
 * Bi-directional sync between the active workspace tab and the URL.
 *
 *  URL → store: when the user lands on /orders/123 (or /orders/create), we
 *    ensure a tab for that workflow exists and is active. Handles deep
 *    links, page refresh, browser back/forward.
 *
 *  store → URL: switching tabs via the strip / keyboard updates the URL
 *    to the tab's canonical href, but ONLY when we're already on a
 *    workspace route. Switching tabs while on /admin/users does NOT
 *    navigate — the user stays on their admin page.
 *
 * No tab is ever auto-opened while the user is on a non-workspace route,
 * so navigating /dashboard → /admin/users never spawns ghost tabs.
 */
export function useWorkspaceUrlSync() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onWorkspaceRoute = isWorkspaceRoute(pathname);

  // -----------------------------------------------------------------
  // URL → store
  // -----------------------------------------------------------------
  React.useEffect(() => {
    if (!onWorkspaceRoute) return;
    const store = useWorkspaceStore.getState();

    // Try to match an existing tab.
    const search = new URLSearchParams(searchParams.toString());
    const existing = store.tabs.find((t) => tabMatchesUrl(t, pathname, search));
    if (existing) {
      if (existing.id !== store.activeTabId) {
        store.switchTab(existing.id);
      }
      return;
    }

    // Otherwise open the right kind of tab for this URL.
    if (pathname === "/orders/create") {
      const draftParam = search.get("draft");
      if (draftParam) {
        store.openTab({
          type: WorkspaceTabType.DRAFT_ORDER,
          payload: { draftId: draftParam },
        });
      } else {
        store.openTab({ type: WorkspaceTabType.CREATE_ORDER });
      }
      return;
    }

    const orderMatch = pathname.match(/^\/orders\/([^/]+)$/);
    if (orderMatch) {
      const orderId = orderMatch[1];
      const focusPayment = search.get("focus") === "payment";
      store.openTab({
        type: focusPayment
          ? WorkspaceTabType.PAYMENT_REVIEW
          : WorkspaceTabType.ORDER_DETAILS,
        payload: { orderId },
      });
    }
  }, [onWorkspaceRoute, pathname, searchParams]);

  // -----------------------------------------------------------------
  // store → URL: switching tabs (anywhere) navigates to that tab's URL.
  // No-ops when the URL already matches, so this is safe to subscribe
  // regardless of the current route.
  // -----------------------------------------------------------------
  React.useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      if (state.activeTabId === prev.activeTabId) return;
      if (!state.activeTabId) return;
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return;
      const target = tabUrlFor(tab);
      const currentUrl = window.location.pathname + window.location.search;
      if (target === currentUrl) return;
      router.push(target);
    });
    return unsubscribe;
  }, [router]);

  // -----------------------------------------------------------------
  // Tab closed while user was on its URL → navigate to next-best route.
  // Only fires when we're currently on a workspace route AND the close
  // emptied the active slot.
  // -----------------------------------------------------------------
  React.useEffect(() => {
    if (!onWorkspaceRoute) return;
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      if (state.activeTabId) return;
      if (prev.activeTabId === null) return;
      router.push("/orders");
    });
    return unsubscribe;
  }, [onWorkspaceRoute, router]);
}

/**
 * Expose a derived "is the page chrome showing workspace content?" so the
 * shell can decide whether to render TabContentHost vs. {children}.
 */
export function useIsWorkspaceRoute(): boolean {
  const pathname = usePathname();
  return isWorkspaceRoute(pathname);
}

export function useActiveTab(): WorkspaceTab | null {
  return useWorkspaceStore((s) =>
    s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) ?? null : null,
  );
}
