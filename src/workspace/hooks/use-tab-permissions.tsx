"use client";

import * as React from "react";

import type { UserRole } from "@/lib/constants/enums";

/**
 * Lets tab content components ask "what permissions does the current
 * operator have?" without re-fetching the session — the value is published
 * once from the layout via context.
 */
interface TabPermissionsValue {
  role: UserRole;
  userId: string;
}

const Ctx = React.createContext<TabPermissionsValue | null>(null);

export function TabPermissionsProvider({
  value,
  children,
}: {
  value: TabPermissionsValue;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabPermissions(): TabPermissionsValue {
  const v = React.useContext(Ctx);
  if (!v) {
    throw new Error(
      "useTabPermissions must be used inside <TabPermissionsProvider>",
    );
  }
  return v;
}
