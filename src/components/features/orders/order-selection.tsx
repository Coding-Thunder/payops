"use client";

import * as React from "react";

/**
 * The orders an operator has ticked in the list.
 *
 * Bulk actions act on THIS, never on the list's current filters: the
 * filters decide what can be seen and ticked, the ticks decide what is
 * acted on. Export reads it from the page header while the checkboxes live
 * in the table, so the set is shared rather than owned by either.
 *
 * It is keyed by order id, so a selection survives the list re-rendering
 * under it — including a move to another page, where the ticked orders stay
 * ticked even though their rows are no longer on screen. The count shown
 * beside every bulk action is what keeps that honest.
 */
export interface OrderSelection {
  selected: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  toggle: (id: string, checked: boolean) => void;
  /** Tick or untick a whole page of rows in one go. */
  setMany: (ids: string[], checked: boolean) => void;
  clear: () => void;
}

const OrderSelectionContext = React.createContext<OrderSelection | null>(null);

/** The selection store itself — one per provider, or per table without one. */
function useSelectionStore(): OrderSelection {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  return React.useMemo<OrderSelection>(
    () => ({
      selected,
      isSelected: (id) => selected.has(id),
      toggle: (id, checked) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (checked) next.add(id);
          else next.delete(id);
          return next;
        }),
      setMany: (ids, checked) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (checked) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
      clear: () => setSelected(new Set<string>()),
    }),
    [selected],
  );
}

/**
 * Shares one selection between the Orders table and the bulk actions in the
 * page header. Wraps server-rendered children, so the page stays a server
 * component.
 */
export function OrderSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = useSelectionStore();
  return (
    <OrderSelectionContext.Provider value={store}>
      {children}
    </OrderSelectionContext.Provider>
  );
}

/**
 * The shared selection, or a private one when there is no provider — the
 * dashboard's recent-orders table renders without bulk actions and must not
 * need the page to wrap it.
 */
export function useOrderSelection(): OrderSelection {
  const shared = React.useContext(OrderSelectionContext);
  const local = useSelectionStore();
  return shared ?? local;
}
