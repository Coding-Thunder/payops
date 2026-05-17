"use client";

import * as React from "react";

import { useWorkspaceStore } from "../store";

/**
 * Global keyboard shortcuts for the workspace.
 *
 *  - Cmd/Ctrl + W           → close active tab (warn if dirty)
 *  - Cmd/Ctrl + Shift + T   → reopen most-recently-closed tab
 *  - Cmd/Ctrl + Alt + Right → next tab
 *  - Cmd/Ctrl + Alt + Left  → previous tab
 *  - Cmd/Ctrl + 1..9        → switch to tab N
 *
 * Cmd+K is owned by the existing command palette and intentionally not
 * intercepted here.
 *
 * `confirmCloseDirty` is supplied by the shell — it returns a Promise that
 * resolves true once the user has confirmed (or the tab was clean).
 */
export function useWorkspaceShortcuts({
  confirmCloseDirty,
}: {
  confirmCloseDirty: (tabId: string) => Promise<boolean>;
}) {
  // Refs to keep handlers stable across re-renders.
  const confirmRef = React.useRef(confirmCloseDirty);
  React.useEffect(() => {
    confirmRef.current = confirmCloseDirty;
  });

  React.useEffect(() => {
    function isEditableTarget(e: KeyboardEvent): boolean {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      if (t.isContentEditable) return true;
      const tag = t.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        // Allow Cmd+W to still close even when focus is in an input —
        // browsers map Cmd+W to "close tab" which we want to override.
        return false;
      }
      return false;
    }

    async function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Cmd+W → close active tab.
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        const state = useWorkspaceStore.getState();
        if (!state.activeTabId) return;
        e.preventDefault();
        const id = state.activeTabId;
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab) return;
        if (tab.dirty) {
          const ok = await confirmRef.current(id);
          if (!ok) return;
          state.closeTab(id, { force: true });
        } else {
          state.closeTab(id);
        }
        return;
      }

      // Cmd+Shift+T → reopen last closed.
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        const state = useWorkspaceStore.getState();
        if (state.closedStack.length === 0) return;
        e.preventDefault();
        state.reopenLastClosed();
        return;
      }

      // Cmd+Alt+Arrow → cycle tabs.
      if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        const state = useWorkspaceStore.getState();
        if (state.tabs.length < 2) return;
        const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (idx === -1) return;
        const next =
          e.key === "ArrowRight"
            ? (idx + 1) % state.tabs.length
            : (idx - 1 + state.tabs.length) % state.tabs.length;
        e.preventDefault();
        state.switchTab(state.tabs[next].id);
        return;
      }

      // Cmd+1..9 → switch to tab N (1-indexed).
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        if (isEditableTarget(e)) return;
        const state = useWorkspaceStore.getState();
        const idx = Number.parseInt(e.key, 10) - 1;
        const target = state.tabs[idx];
        if (!target) return;
        e.preventDefault();
        state.switchTab(target.id);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
