/**
 * The Orders list filters the operator has chosen but the page may not have
 * finished applying yet.
 *
 * Filters apply through a client navigation, so for a moment after a change
 * the page — and its URL — still describe the previous filters. An export
 * started in that moment used to download the previous list. The filter bar
 * records its intent here the instant it changes; the export reads it.
 */
let intended: string | null = null;

export function setIntendedOrderFilters(search: string): void {
  intended = search;
}

/** The filters to act on: what was chosen, or what is applied. */
export function currentOrderFilters(applied: string): string {
  return intended ?? applied;
}

let lastApplied: string | null = null;

/**
 * Called on every render of the filter bar with the filters the page shows.
 * Once the page moves to ANY other filters — the ones chosen, or somewhere
 * else the operator navigated before they applied — the old intent is done:
 * an export must never use a choice the page has since moved away from.
 */
export function settleOrderFilters(applied: string): void {
  // Any change of URL — including only the page — means a navigation has
  // completed, and a choice made before it no longer describes the list.
  if (lastApplied !== null && lastApplied !== applied) intended = null;
  if (intended !== null && sameFilters(intended, applied)) intended = null;
  lastApplied = applied;
}

/** A fresh Orders page starts with no pending choice. */
export function resetOrderFilters(applied: string): void {
  intended = null;
  lastApplied = applied;
}

function sameFilters(a: string, b: string): boolean {
  const norm = (s: string) => {
    const p = new URLSearchParams(s);
    p.delete("page");
    p.sort();
    return p.toString();
  };
  return norm(a) === norm(b);
}
