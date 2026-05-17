"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import {
  CLOSED_TAB_STACK_LIMIT,
  WORKSPACE_TAB_LIMIT,
  WorkspaceTabType,
  type ClosedTabSnapshot,
  type OpenTabInput,
  type WorkspaceTab,
} from "./types";

export interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /**
   * LIFO stack of recently-closed tabs. Top of stack is the most recent.
   * Bounded by CLOSED_TAB_STACK_LIMIT.
   */
  closedStack: ClosedTabSnapshot[];

  /**
   * Open (or focus) a tab. Returns the resulting tab id.
   *
   * Semantics:
   *  - For ORDER_DETAILS / PAYMENT_REVIEW / DRAFT_ORDER, if a tab with the
   *    same identifier (orderId / draftId) already exists we ACTIVATE it
   *    instead of duplicating.
   *  - CREATE_ORDER is a singleton — repeated openTab activates the one in
   *    the workspace, otherwise creates one.
   *  - When the workspace is at WORKSPACE_TAB_LIMIT, the least-recently
   *    opened CLEAN tab is evicted to make room. Dirty tabs are spared.
   *
   * `options.activate` defaults to true. Pass `false` to open in the
   * background (middle-click semantics) — the tab is created/added but the
   * current active tab is preserved, so the URL doesn't change.
   */
  openTab: (input: OpenTabInput, options?: { activate?: boolean }) => string;

  /** Activate by id; no-op if the id isn't in the workspace. */
  switchTab: (id: string) => void;

  /**
   * Close a tab by id. If `force` is false (default) and the tab is dirty,
   * returns `false` so the UI can prompt the user. `true` once closed.
   */
  closeTab: (id: string, options?: { force?: boolean }) => boolean;

  /** Close every tab. Dirty tabs are spared unless `force` is set. */
  closeAll: (options?: { force?: boolean }) => void;

  /** Close every other tab. Dirty tabs are spared unless `force` is set. */
  closeOthers: (keepId: string, options?: { force?: boolean }) => void;

  /** Pop the most-recently closed tab back into the workspace. */
  reopenLastClosed: () => string | null;

  /** Set dirty/clean state for a tab. */
  setDirty: (id: string, dirty: boolean) => void;

  /** Patch a tab's display label (e.g. once an order number resolves). */
  updateTabMeta: (
    id: string,
    patch: Partial<Pick<WorkspaceTab, "label" | "subtitle">>,
  ) => void;

  /**
   * Drop a tab whose underlying record was deleted (e.g. an order archived
   * elsewhere). Skips the dirty-check.
   */
  evictTab: (id: string) => void;
}

const initialState: Pick<WorkspaceState, "tabs" | "activeTabId" | "closedStack"> = {
  tabs: [],
  activeTabId: null,
  closedStack: [],
};

function genId(): string {
  // Short, stable, URL-safe. Avoids needing `crypto.randomUUID` on the SSR
  // path (the store is client-only, but tests run in jsdom).
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36).slice(-6);
  return `tab_${time}${rand}`;
}

function defaultLabelFor(input: OpenTabInput): string {
  switch (input.type) {
    case WorkspaceTabType.CREATE_ORDER:
      return "New order";
    case WorkspaceTabType.DRAFT_ORDER:
      return input.label ?? input.payload.summary ?? "Draft order";
    case WorkspaceTabType.ORDER_DETAILS:
      return (
        input.label ??
        input.payload.orderNumber ??
        input.payload.customerName ??
        "Order"
      );
    case WorkspaceTabType.PAYMENT_REVIEW:
      return (
        input.label ??
        `${input.payload.orderNumber ?? "Order"} · Payment`
      );
  }
}

function findExisting(
  tabs: WorkspaceTab[],
  input: OpenTabInput,
): WorkspaceTab | undefined {
  return tabs.find((t) => {
    if (t.type !== input.type) return false;
    switch (input.type) {
      case WorkspaceTabType.CREATE_ORDER:
        // Singleton.
        return true;
      case WorkspaceTabType.DRAFT_ORDER:
        return (
          t.type === WorkspaceTabType.DRAFT_ORDER &&
          t.payload.draftId === input.payload.draftId
        );
      case WorkspaceTabType.ORDER_DETAILS:
        return (
          t.type === WorkspaceTabType.ORDER_DETAILS &&
          t.payload.orderId === input.payload.orderId
        );
      case WorkspaceTabType.PAYMENT_REVIEW:
        return (
          t.type === WorkspaceTabType.PAYMENT_REVIEW &&
          t.payload.orderId === input.payload.orderId
        );
    }
  });
}

function buildTab(input: OpenTabInput): WorkspaceTab {
  const base = {
    id: genId(),
    label: defaultLabelFor(input),
    openedAt: new Date().toISOString(),
    dirty: false,
  };
  switch (input.type) {
    case WorkspaceTabType.CREATE_ORDER:
      return { ...base, type: WorkspaceTabType.CREATE_ORDER };
    case WorkspaceTabType.DRAFT_ORDER:
      return {
        ...base,
        type: WorkspaceTabType.DRAFT_ORDER,
        payload: input.payload,
      };
    case WorkspaceTabType.ORDER_DETAILS:
      return {
        ...base,
        type: WorkspaceTabType.ORDER_DETAILS,
        payload: input.payload,
      };
    case WorkspaceTabType.PAYMENT_REVIEW:
      return {
        ...base,
        type: WorkspaceTabType.PAYMENT_REVIEW,
        payload: input.payload,
      };
  }
}

/**
 * Pick the next active tab after closing `closedId`. Prefers the tab to
 * the right, falls back to the one to the left, then null.
 */
function nextActiveAfterClose(
  tabs: WorkspaceTab[],
  closedId: string,
  currentActive: string | null,
): string | null {
  if (currentActive !== closedId) return currentActive;
  const idx = tabs.findIndex((t) => t.id === closedId);
  if (idx === -1) return currentActive;
  const right = tabs[idx + 1];
  if (right) return right.id;
  const left = tabs[idx - 1];
  if (left) return left.id;
  return null;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      ...initialState,

      openTab(input, options) {
        const activate = options?.activate !== false;
        const existing = findExisting(get().tabs, input);
        if (existing) {
          if (activate) set({ activeTabId: existing.id });
          return existing.id;
        }

        let nextTabs = [...get().tabs];

        // Enforce the workspace limit by evicting the oldest CLEAN tab.
        if (nextTabs.length >= WORKSPACE_TAB_LIMIT) {
          const oldestCleanIdx = nextTabs
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => !t.dirty)
            .sort(
              (a, b) =>
                Date.parse(a.t.openedAt) - Date.parse(b.t.openedAt),
            )[0]?.i;
          if (oldestCleanIdx !== undefined) {
            nextTabs.splice(oldestCleanIdx, 1);
          } else {
            // Everything is dirty — drop the oldest one anyway so the UI
            // never deadlocks. Snapshot it so the user can reopen it.
            const sacrificed = nextTabs[0];
            if (sacrificed) {
              get().closedStack.unshift({
                tab: sacrificed,
                closedAt: new Date().toISOString(),
              });
              nextTabs = nextTabs.slice(1);
            }
          }
        }

        const tab = buildTab(input);
        nextTabs.push(tab);
        set({
          tabs: nextTabs,
          activeTabId: activate ? tab.id : get().activeTabId,
        });
        return tab.id;
      },

      switchTab(id) {
        const exists = get().tabs.some((t) => t.id === id);
        if (!exists) return;
        if (get().activeTabId === id) return;
        set({ activeTabId: id });
      },

      closeTab(id, { force = false } = {}) {
        const state = get();
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab) return true;
        if (tab.dirty && !force) return false;
        const remaining = state.tabs.filter((t) => t.id !== id);
        const nextActive = nextActiveAfterClose(
          state.tabs,
          id,
          state.activeTabId,
        );
        const closedStack = [
          { tab, closedAt: new Date().toISOString() },
          ...state.closedStack,
        ].slice(0, CLOSED_TAB_STACK_LIMIT);
        set({
          tabs: remaining,
          activeTabId: nextActive,
          closedStack,
        });
        return true;
      },

      closeAll({ force = false } = {}) {
        const state = get();
        const survivors = force ? [] : state.tabs.filter((t) => t.dirty);
        const closed = state.tabs.filter((t) => !survivors.includes(t));
        const now = new Date().toISOString();
        const closedStack = [
          ...closed.map((tab) => ({ tab, closedAt: now })).reverse(),
          ...state.closedStack,
        ].slice(0, CLOSED_TAB_STACK_LIMIT);
        const nextActive =
          state.activeTabId && survivors.some((t) => t.id === state.activeTabId)
            ? state.activeTabId
            : survivors[0]?.id ?? null;
        set({ tabs: survivors, activeTabId: nextActive, closedStack });
      },

      closeOthers(keepId, { force = false } = {}) {
        const state = get();
        const keep = state.tabs.find((t) => t.id === keepId);
        if (!keep) return;
        const survivors = state.tabs.filter(
          (t) => t.id === keepId || (!force && t.dirty),
        );
        const closed = state.tabs.filter((t) => !survivors.includes(t));
        const now = new Date().toISOString();
        const closedStack = [
          ...closed.map((tab) => ({ tab, closedAt: now })).reverse(),
          ...state.closedStack,
        ].slice(0, CLOSED_TAB_STACK_LIMIT);
        set({ tabs: survivors, activeTabId: keepId, closedStack });
      },

      reopenLastClosed() {
        const state = get();
        const top = state.closedStack[0];
        if (!top) return null;
        // Don't duplicate if the same workflow is already open.
        let existing: WorkspaceTab | undefined;
        if (top.tab.type === WorkspaceTabType.ORDER_DETAILS) {
          existing = state.tabs.find(
            (t) =>
              t.type === WorkspaceTabType.ORDER_DETAILS &&
              t.payload.orderId === top.tab.payload.orderId,
          );
        } else if (top.tab.type === WorkspaceTabType.PAYMENT_REVIEW) {
          existing = state.tabs.find(
            (t) =>
              t.type === WorkspaceTabType.PAYMENT_REVIEW &&
              t.payload.orderId === top.tab.payload.orderId,
          );
        } else if (top.tab.type === WorkspaceTabType.DRAFT_ORDER) {
          existing = state.tabs.find(
            (t) =>
              t.type === WorkspaceTabType.DRAFT_ORDER &&
              t.payload.draftId === top.tab.payload.draftId,
          );
        } else if (top.tab.type === WorkspaceTabType.CREATE_ORDER) {
          existing = state.tabs.find(
            (t) => t.type === WorkspaceTabType.CREATE_ORDER,
          );
        }
        if (existing) {
          set({
            activeTabId: existing.id,
            closedStack: state.closedStack.slice(1),
          });
          return existing.id;
        }
        const restored: WorkspaceTab = {
          ...top.tab,
          openedAt: new Date().toISOString(),
          dirty: false,
        };
        set({
          tabs: [...state.tabs, restored],
          activeTabId: restored.id,
          closedStack: state.closedStack.slice(1),
        });
        return restored.id;
      },

      setDirty(id, dirty) {
        const tabs = get().tabs.map((t) =>
          t.id === id ? { ...t, dirty } : t,
        );
        set({ tabs });
      },

      updateTabMeta(id, patch) {
        const tabs = get().tabs.map((t) =>
          t.id === id ? { ...t, ...patch } : t,
        );
        set({ tabs });
      },

      evictTab(id) {
        const state = get();
        const remaining = state.tabs.filter((t) => t.id !== id);
        const nextActive = nextActiveAfterClose(
          state.tabs,
          id,
          state.activeTabId,
        );
        set({ tabs: remaining, activeTabId: nextActive });
      },
    }),
    {
      name: "payops:workspace:v1",
      storage: createJSONStorage(() => safeStorage()),
      // Don't persist transient `dirty` state — it's recomputed by the
      // mounted tab contents when they hydrate.
      partialize: (state) => ({
        // Strip the transient `dirty` flag — it's recomputed by the mounted
        // tab contents when they hydrate.
        tabs: state.tabs.map((t) => ({ ...t, dirty: false })) as WorkspaceTab[],
        activeTabId: state.activeTabId,
        closedStack: state.closedStack,
      }),
      version: 1,
    },
  ),
);

/**
 * Storage adapter: prefer window.localStorage when available, fall back to
 * an in-memory no-op shim for SSR / contexts where the browser API is
 * missing or throws (private browsing, sandboxed iframes).
 */
const memoryStore = new Map<string, string>();
function safeStorage(): Storage {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      // Touch localStorage so we surface throws (Safari private mode).
      const probe = "__payops_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch {
      // fall through
    }
  }
  return {
    length: 0,
    clear: () => memoryStore.clear(),
    getItem: (k) => memoryStore.get(k) ?? null,
    key: (i) => Array.from(memoryStore.keys())[i] ?? null,
    removeItem: (k) => {
      memoryStore.delete(k);
    },
    setItem: (k, v) => {
      memoryStore.set(k, v);
    },
  };
}

/** Selectors — keep components subscribing to the narrowest slice possible. */
export const workspaceSelectors = {
  activeTab: (s: WorkspaceState): WorkspaceTab | undefined =>
    s.tabs.find((t) => t.id === s.activeTabId),
  tabCount: (s: WorkspaceState): number => s.tabs.length,
  hasDirtyTabs: (s: WorkspaceState): boolean => s.tabs.some((t) => t.dirty),
};
