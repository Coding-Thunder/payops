import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspaceStore } from "@/workspace/store";
import {
  WORKSPACE_TAB_LIMIT,
  WorkspaceTabType,
  isWorkspaceRoute,
  tabMatchesUrl,
  tabUrlFor,
  type DraftOrderTab,
  type OrderDetailsTab,
} from "@/workspace/types";

/**
 * Workspace store unit tests. The store is plain TypeScript with no React
 * — we test it directly via `useWorkspaceStore.getState()` rather than
 * mounting components, so these run fast and cover the contract precisely.
 */
function reset() {
  useWorkspaceStore.setState({
    tabs: [],
    activeTabId: null,
    closedStack: [],
  });
}

beforeEach(() => {
  reset();
});

describe("workspaceStore.openTab", () => {
  it("creates a tab and makes it active by default", () => {
    const store = useWorkspaceStore.getState();
    const id = store.openTab({ type: WorkspaceTabType.CREATE_ORDER });
    const next = useWorkspaceStore.getState();
    expect(next.tabs).toHaveLength(1);
    expect(next.activeTabId).toBe(id);
    expect(next.tabs[0].type).toBe(WorkspaceTabType.CREATE_ORDER);
  });

  it("treats CREATE_ORDER as a singleton — repeated open activates", () => {
    const a = useWorkspaceStore
      .getState()
      .openTab({ type: WorkspaceTabType.CREATE_ORDER });
    // Open a different tab to shift the active pointer.
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "abc" },
    });
    const b = useWorkspaceStore
      .getState()
      .openTab({ type: WorkspaceTabType.CREATE_ORDER });
    expect(a).toBe(b);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
    expect(useWorkspaceStore.getState().activeTabId).toBe(a);
  });

  it("dedupes ORDER_DETAILS by orderId", () => {
    const a = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "order_1" },
    });
    const b = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "order_1" },
    });
    expect(a).toBe(b);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  });

  it("opens distinct orders as separate tabs", () => {
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "order_1" },
    });
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "order_2" },
    });
    expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
  });

  it("opens in background when activate=false", () => {
    const first = useWorkspaceStore
      .getState()
      .openTab({ type: WorkspaceTabType.CREATE_ORDER });
    const second = useWorkspaceStore.getState().openTab(
      {
        type: WorkspaceTabType.ORDER_DETAILS,
        payload: { orderId: "order_9" },
      },
      { activate: false },
    );
    const state = useWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(first);
    expect(state.activeTabId).not.toBe(second);
  });

  it("evicts the oldest clean tab when at the limit", () => {
    // Fill the workspace beyond the limit.
    for (let i = 0; i < WORKSPACE_TAB_LIMIT; i++) {
      useWorkspaceStore.getState().openTab({
        type: WorkspaceTabType.ORDER_DETAILS,
        payload: { orderId: `order_${i}` },
      });
    }
    expect(useWorkspaceStore.getState().tabs).toHaveLength(
      WORKSPACE_TAB_LIMIT,
    );
    // Open one more — oldest gets evicted.
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: `order_overflow` },
    });
    const tabs = useWorkspaceStore.getState().tabs;
    expect(tabs).toHaveLength(WORKSPACE_TAB_LIMIT);
    // order_0 (the oldest) should be gone.
    const ids = tabs.map((t) =>
      t.type === WorkspaceTabType.ORDER_DETAILS ? t.payload.orderId : "",
    );
    expect(ids).not.toContain("order_0");
    expect(ids).toContain("order_overflow");
  });

  it("spares dirty tabs from eviction", () => {
    for (let i = 0; i < WORKSPACE_TAB_LIMIT; i++) {
      useWorkspaceStore.getState().openTab({
        type: WorkspaceTabType.ORDER_DETAILS,
        payload: { orderId: `order_${i}` },
      });
    }
    // Mark the oldest dirty.
    const oldest = useWorkspaceStore.getState().tabs[0].id;
    useWorkspaceStore.getState().setDirty(oldest, true);
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "fresh" },
    });
    const tabs = useWorkspaceStore.getState().tabs;
    expect(tabs.find((t) => t.id === oldest)).toBeDefined();
  });
});

describe("workspaceStore.closeTab", () => {
  it("refuses to close a dirty tab without force", () => {
    const id = useWorkspaceStore
      .getState()
      .openTab({ type: WorkspaceTabType.CREATE_ORDER });
    useWorkspaceStore.getState().setDirty(id, true);
    const closed = useWorkspaceStore.getState().closeTab(id);
    expect(closed).toBe(false);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  });

  it("closes a dirty tab when force=true", () => {
    const id = useWorkspaceStore
      .getState()
      .openTab({ type: WorkspaceTabType.CREATE_ORDER });
    useWorkspaceStore.getState().setDirty(id, true);
    const closed = useWorkspaceStore.getState().closeTab(id, { force: true });
    expect(closed).toBe(true);
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });

  it("pushes closed tabs onto the reopen stack", () => {
    const id = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "x" },
    });
    useWorkspaceStore.getState().closeTab(id);
    expect(useWorkspaceStore.getState().closedStack).toHaveLength(1);
  });

  it("activates the right neighbor when closing the active tab", () => {
    const a = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "a" },
    });
    const b = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "b" },
    });
    const c = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "c" },
    });
    useWorkspaceStore.getState().switchTab(b);
    useWorkspaceStore.getState().closeTab(b);
    expect(useWorkspaceStore.getState().activeTabId).toBe(c);
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual([a, c]);
  });

  it("falls back to the left neighbor when closing the last tab", () => {
    const a = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "a" },
    });
    const b = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "b" },
    });
    useWorkspaceStore.getState().closeTab(b);
    expect(useWorkspaceStore.getState().activeTabId).toBe(a);
  });
});

describe("workspaceStore.reopenLastClosed", () => {
  it("restores the most recently closed tab", () => {
    const id = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "alpha" },
    });
    useWorkspaceStore.getState().closeTab(id);
    const restored = useWorkspaceStore.getState().reopenLastClosed();
    expect(restored).not.toBeNull();
    const tabs = useWorkspaceStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect((tabs[0] as OrderDetailsTab).payload.orderId).toBe("alpha");
  });

  it("activates an existing tab rather than duplicating", () => {
    const id = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "alpha" },
    });
    useWorkspaceStore.getState().closeTab(id);
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "alpha" },
    });
    useWorkspaceStore.getState().reopenLastClosed();
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  });
});

describe("workspaceStore.closeAll / closeOthers", () => {
  it("closeAll keeps dirty tabs by default", () => {
    const a = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "a" },
    });
    useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "b" },
    });
    useWorkspaceStore.getState().setDirty(a, true);
    useWorkspaceStore.getState().closeAll();
    const tabs = useWorkspaceStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(a);
  });

  it("closeOthers preserves the kept tab and dirty ones", () => {
    const a = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "a" },
    });
    const b = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "b" },
    });
    const c = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "c" },
    });
    useWorkspaceStore.getState().setDirty(c, true);
    useWorkspaceStore.getState().closeOthers(a);
    const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
    expect(ids).toContain(a);
    expect(ids).toContain(c);
    expect(ids).not.toContain(b);
  });
});

describe("workspaceStore selectors", () => {
  it("setDirty flips the tab's dirty flag without losing other state", () => {
    const id = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.DRAFT_ORDER,
      payload: { draftId: "d1" },
    });
    useWorkspaceStore.getState().setDirty(id, true);
    const tab = useWorkspaceStore.getState().tabs[0] as DraftOrderTab;
    expect(tab.dirty).toBe(true);
    expect(tab.payload.draftId).toBe("d1");
  });

  it("updateTabMeta patches label/subtitle", () => {
    const id = useWorkspaceStore.getState().openTab({
      type: WorkspaceTabType.ORDER_DETAILS,
      payload: { orderId: "x" },
    });
    useWorkspaceStore.getState().updateTabMeta(id, {
      label: "PAY-1234",
      subtitle: "Jane Doe",
    });
    const tab = useWorkspaceStore.getState().tabs[0];
    expect(tab.label).toBe("PAY-1234");
    expect(tab.subtitle).toBe("Jane Doe");
  });
});

describe("URL helpers", () => {
  it("isWorkspaceRoute matches /orders/:id and /orders/create", () => {
    expect(isWorkspaceRoute("/orders/abc")).toBe(true);
    expect(isWorkspaceRoute("/orders/create")).toBe(true);
    expect(isWorkspaceRoute("/orders")).toBe(false);
    expect(isWorkspaceRoute("/dashboard")).toBe(false);
    expect(isWorkspaceRoute("/admin/users")).toBe(false);
  });

  it("tabUrlFor builds the canonical URL per tab type", () => {
    expect(
      tabUrlFor({
        id: "t",
        type: WorkspaceTabType.ORDER_DETAILS,
        label: "x",
        openedAt: "",
        payload: { orderId: "abc" },
      }),
    ).toBe("/orders/abc");
    expect(
      tabUrlFor({
        id: "t",
        type: WorkspaceTabType.PAYMENT_REVIEW,
        label: "x",
        openedAt: "",
        payload: { orderId: "abc" },
      }),
    ).toBe("/orders/abc?focus=payment");
    expect(
      tabUrlFor({
        id: "t",
        type: WorkspaceTabType.CREATE_ORDER,
        label: "x",
        openedAt: "",
      }),
    ).toBe("/orders/create");
    expect(
      tabUrlFor({
        id: "t",
        type: WorkspaceTabType.DRAFT_ORDER,
        label: "x",
        openedAt: "",
        payload: { draftId: "d1" },
      }),
    ).toBe("/orders/create?draft=d1");
  });

  it("tabMatchesUrl distinguishes ORDER_DETAILS from PAYMENT_REVIEW", () => {
    const tab: OrderDetailsTab = {
      id: "t",
      type: WorkspaceTabType.ORDER_DETAILS,
      label: "x",
      openedAt: "",
      payload: { orderId: "abc" },
    };
    expect(tabMatchesUrl(tab, "/orders/abc", new URLSearchParams(""))).toBe(
      true,
    );
    expect(
      tabMatchesUrl(tab, "/orders/abc", new URLSearchParams("focus=payment")),
    ).toBe(false);
  });
});
