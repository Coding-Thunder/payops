/**
 * Workspace tab type system. Strict discriminated unions — every tab kind
 * declares its own payload shape so consumers never deal with `any`.
 *
 * Tabs are workflow contexts (orders, drafts, payment reviews). Settings,
 * branding, analytics, and admin config pages are intentionally NOT tabs.
 */

export const WorkspaceTabType = {
  /** A blank "new order" form. Becomes a DRAFT_ORDER once it has a draftId. */
  CREATE_ORDER: "CREATE_ORDER",
  /** An autosaved partial create-order form, persisted to the drafts API. */
  DRAFT_ORDER: "DRAFT_ORDER",
  /** Existing order — read/update + payment + risk + inline composer. */
  ORDER_DETAILS: "ORDER_DETAILS",
  /** Same as ORDER_DETAILS but the payment / risk section is focused. */
  PAYMENT_REVIEW: "PAYMENT_REVIEW",
} as const;

export type WorkspaceTabType =
  (typeof WorkspaceTabType)[keyof typeof WorkspaceTabType];

interface BaseTab {
  /** Stable, unique within the workspace. */
  id: string;
  type: WorkspaceTabType;
  /** Short label rendered in the tab strip. */
  label: string;
  /** Optional secondary text shown on hover. */
  subtitle?: string;
  /** ISO timestamp when the tab was opened (used for "recently opened"). */
  openedAt: string;
  /**
   * True when the workflow inside the tab has unsaved local changes. Drives
   * the "● dot" indicator and the close-tab confirmation.
   */
  dirty?: boolean;
}

export interface CreateOrderTab extends BaseTab {
  type: typeof WorkspaceTabType.CREATE_ORDER;
}

export interface DraftOrderTab extends BaseTab {
  type: typeof WorkspaceTabType.DRAFT_ORDER;
  payload: {
    draftId: string;
    /** Optional summary like customer name so the label is meaningful. */
    summary?: string;
  };
}

export interface OrderDetailsTab extends BaseTab {
  type: typeof WorkspaceTabType.ORDER_DETAILS;
  payload: {
    orderId: string;
    /** Pre-fetched display fields so the tab strip never shows a placeholder. */
    orderNumber?: string;
    customerName?: string;
  };
}

export interface PaymentReviewTab extends BaseTab {
  type: typeof WorkspaceTabType.PAYMENT_REVIEW;
  payload: {
    orderId: string;
    orderNumber?: string;
    customerName?: string;
  };
}

export type WorkspaceTab =
  | CreateOrderTab
  | DraftOrderTab
  | OrderDetailsTab
  | PaymentReviewTab;

/**
 * Input shape for openTab — everything the store needs to either reopen an
 * existing equivalent tab or create a fresh one. The store assigns the
 * stable `id` and `openedAt`.
 */
export type OpenTabInput =
  | { type: typeof WorkspaceTabType.CREATE_ORDER }
  | {
      type: typeof WorkspaceTabType.DRAFT_ORDER;
      payload: DraftOrderTab["payload"];
      label?: string;
    }
  | {
      type: typeof WorkspaceTabType.ORDER_DETAILS;
      payload: OrderDetailsTab["payload"];
      label?: string;
    }
  | {
      type: typeof WorkspaceTabType.PAYMENT_REVIEW;
      payload: PaymentReviewTab["payload"];
      label?: string;
    };

/** Snapshot of a closed tab — used by the "reopen tab" stack. */
export interface ClosedTabSnapshot {
  tab: WorkspaceTab;
  closedAt: string;
}

export const WORKSPACE_TAB_LIMIT = 12;
export const CLOSED_TAB_STACK_LIMIT = 10;

/**
 * URL ↔ tab inference helpers.
 *
 * These are the only two places in the codebase that know the URL → tab
 * mapping. Keep them pure so the store can be tested in isolation.
 */
export function tabUrlFor(tab: WorkspaceTab): string {
  switch (tab.type) {
    case WorkspaceTabType.ORDER_DETAILS:
      return `/orders/${tab.payload.orderId}`;
    case WorkspaceTabType.PAYMENT_REVIEW:
      return `/orders/${tab.payload.orderId}?focus=payment`;
    case WorkspaceTabType.CREATE_ORDER:
      return `/orders/create`;
    case WorkspaceTabType.DRAFT_ORDER:
      return `/orders/create?draft=${encodeURIComponent(tab.payload.draftId)}`;
  }
}

/**
 * Does this tab "own" the given URL? Used to decide whether navigating to
 * `pathname + search` should activate an existing tab vs. open a new one.
 */
export function tabMatchesUrl(
  tab: WorkspaceTab,
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  switch (tab.type) {
    case WorkspaceTabType.ORDER_DETAILS:
      return (
        pathname === `/orders/${tab.payload.orderId}` &&
        searchParams.get("focus") !== "payment"
      );
    case WorkspaceTabType.PAYMENT_REVIEW:
      return (
        pathname === `/orders/${tab.payload.orderId}` &&
        searchParams.get("focus") === "payment"
      );
    case WorkspaceTabType.CREATE_ORDER:
      return (
        pathname === "/orders/create" && !searchParams.get("draft")
      );
    case WorkspaceTabType.DRAFT_ORDER:
      return (
        pathname === "/orders/create" &&
        searchParams.get("draft") === tab.payload.draftId
      );
  }
}

/**
 * Routes that participate in the workspace. Other routes (settings,
 * branding, analytics, admin/*) render normally and ignore the tab strip
 * entirely (it stays visible but no tab is "active" for them).
 */
export function isWorkspaceRoute(pathname: string): boolean {
  if (pathname === "/orders/create") return true;
  // /orders/[id]  — but NOT /orders itself (the list view is not a tab).
  if (/^\/orders\/[^/]+$/.test(pathname) && pathname !== "/orders") return true;
  return false;
}
