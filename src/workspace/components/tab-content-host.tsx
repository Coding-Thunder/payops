"use client";

import * as React from "react";

import { useWorkspaceStore } from "../store";
import { WorkspaceTabType, type WorkspaceTab } from "../types";

// Per-tab content components — kept as static imports rather than dynamic()
// because the bundle is small and we want predictable hydration.
import { CreateOrderTabContent } from "../tabs/create-order";
import { OrderDetailsTabContent } from "../tabs/order-details";

interface TabContentHostProps {
  /**
   * Fallback rendered when the workspace is empty / no active tab.
   */
  fallback: React.ReactNode;
}

/**
 * Renders every open tab once and toggles visibility via `hidden`.
 *
 *  - Inactive tabs stay mounted so React Query caches, scroll positions,
 *    and form state survive a switch. `inert` keeps focus and assistive
 *    tech out of background tabs.
 *  - Closing a tab unmounts its subtree (React frees the state, React
 *    Query reclaims unobserved queries on the configured stale window).
 *
 * With the WORKSPACE_TAB_LIMIT cap (12) the simultaneous mount cost is
 * bounded, and React Query dedupes fetches across same-orderId tabs.
 */
export function TabContentHost({ fallback }: TabContentHostProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  if (!activeTabId || tabs.length === 0) return <>{fallback}</>;

  return (
    <>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            aria-labelledby={tab.id}
            hidden={!active}
            inert={!active}
          >
            <TabSwitch tab={tab} />
          </div>
        );
      })}
    </>
  );
}

function TabSwitch({ tab }: { tab: WorkspaceTab }) {
  switch (tab.type) {
    case WorkspaceTabType.CREATE_ORDER:
      return <CreateOrderTabContent tabId={tab.id} />;
    case WorkspaceTabType.DRAFT_ORDER:
      return (
        <CreateOrderTabContent tabId={tab.id} draftId={tab.payload.draftId} />
      );
    case WorkspaceTabType.ORDER_DETAILS:
      return (
        <OrderDetailsTabContent
          tabId={tab.id}
          orderId={tab.payload.orderId}
          focus="overview"
        />
      );
    case WorkspaceTabType.PAYMENT_REVIEW:
      return (
        <OrderDetailsTabContent
          tabId={tab.id}
          orderId={tab.payload.orderId}
          focus="payment"
        />
      );
  }
}
