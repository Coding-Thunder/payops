"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  TabPermissionsProvider,
} from "../hooks/use-tab-permissions";
import { useWorkspaceRealtime } from "../hooks/use-workspace-realtime";
import { useWorkspaceShortcuts } from "../hooks/use-workspace-shortcuts";
import {
  useActiveTab,
  useIsWorkspaceRoute,
  useWorkspaceUrlSync,
} from "../hooks/use-workspace-url-sync";
import { useWorkspaceStore } from "../store";
import type { WorkspaceTab } from "../types";
import { TabContentHost } from "./tab-content-host";
import { WorkspaceTabBar } from "./tab-bar";
import type { UserRole } from "@/lib/constants/enums";

interface WorkspaceShellProps {
  user: {
    id: string;
    role: UserRole;
  };
  /**
   * The original page tree (server-rendered). Shown when the user is on a
   * NON-workspace route (dashboard, /admin/*, /orders list, etc.).
   */
  children: React.ReactNode;
}

/**
 * Top-level workspace coordinator. Mounted once inside the authenticated
 * layout, owns:
 *  - the tab bar (sticky under topbar)
 *  - URL ↔ active tab sync
 *  - keyboard shortcuts (Cmd+W, Cmd+Shift+T, Cmd+1..9, Cmd+Alt+←/→)
 *  - realtime → per-tab query invalidation
 *  - the close-dirty confirmation flow
 *
 * Render model:
 *  - workspace route + active tab → renders TabContentHost
 *  - non-workspace route          → renders `children` (the original page)
 *  - inactive tabs ALWAYS remain mounted (just hidden) so query state,
 *    forms, and scroll positions survive navigation away & back.
 */
export function WorkspaceShell({ user, children }: WorkspaceShellProps) {
  useWorkspaceUrlSync();
  useWorkspaceRealtime();

  const isWorkspaceRoute = useIsWorkspaceRoute();
  const activeTab = useActiveTab();

  // ---- Close-dirty confirmation -----------------------------------------
  const [pendingClose, setPendingClose] = React.useState<{
    tab: WorkspaceTab;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const requestCloseDirty = React.useCallback(
    (tabId: string): Promise<boolean> => {
      const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        setPendingClose({ tab, resolve });
      });
    },
    [],
  );

  useWorkspaceShortcuts({ confirmCloseDirty: requestCloseDirty });

  // ---- Tab bar handlers -------------------------------------------------
  const handleActivate = React.useCallback((tab: WorkspaceTab) => {
    useWorkspaceStore.getState().switchTab(tab.id);
  }, []);

  const handleClose = React.useCallback(
    async (tab: WorkspaceTab) => {
      const state = useWorkspaceStore.getState();
      if (!tab.dirty) {
        state.closeTab(tab.id);
        return;
      }
      const ok = await requestCloseDirty(tab.id);
      if (ok) state.closeTab(tab.id, { force: true });
    },
    [requestCloseDirty],
  );

  // ---- Body rendering ---------------------------------------------------
  // We always render BOTH the route children and TabContentHost, then
  // toggle visibility based on whether we're on a workspace route. This
  // keeps tabs mounted (so React Query / form state persist) regardless of
  // current URL. TabContentHost itself manages per-tab hidden state.
  const showHost = isWorkspaceRoute && !!activeTab;

  return (
    <TabPermissionsProvider value={{ role: user.role, userId: user.id }}>
      <WorkspaceTabBar
        onActivate={handleActivate}
        onClose={handleClose}
      />
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8 md:px-8">
        {/* Route children — visible on non-workspace routes only. We use
            display:none rather than conditional rendering so server-rendered
            pages don't get torn down on every tab interaction. */}
        <div hidden={showHost}>{children}</div>
        {/* Tab content host — always mounted so background tabs preserve
            state. Its `hidden` wrapper toggles visibility without
            unmounting the tab subtrees. */}
        <div hidden={!showHost}>
          <TabContentHost fallback={null} />
        </div>
      </div>

      <ConfirmDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open && pendingClose) {
            pendingClose.resolve(false);
            setPendingClose(null);
          }
        }}
        tone="warning"
        title={
          pendingClose ? `Close ${pendingClose.tab.label}?` : "Close tab?"
        }
        description="This tab has unsaved changes. Drafts will be lost. Are you sure?"
        confirmLabel="Close anyway"
        cancelLabel="Keep open"
        onConfirm={() => {
          if (pendingClose) {
            pendingClose.resolve(true);
            setPendingClose(null);
          }
        }}
      />
    </TabPermissionsProvider>
  );
}
