"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ChevronRightIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  ConsentStatusBadge,
  OrderStatusBadge,
} from "@/components/common/status-badges";
import { EmptyState } from "@/components/common/empty-state";
import { ProviderBadge } from "@/components/features/providers";
import {
  resolveProvider,
  UNKNOWN_PROVIDER,
} from "@/lib/constants/providers";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { ConsentStatus, OrderStatus } from "@/lib/constants/enums";
import { api, ApiClientError } from "@/lib/api-client";
import { DELETE_MAX_SELECTION } from "@/lib/validation";
import { outstandingHeldPayments } from "@/lib/payment-state";
import { PAID_FEATURES_ENABLED } from "@/lib/paid-features";
import { useOrderSelection } from "./order-selection";
import {
  formatCurrency,
  formatDate,
  formatRelative,
  resolveOrderAgent,
} from "@/lib/format";
import type { OrderDTO } from "@/types";

/**
 * Density pass for laptop-class viewports.
 *
 * The table was losing to its own column count long before it lost to font
 * size, so this shortens the row box and drops columns earlier rather than
 * scaling type down — text stays at its readable size and the row simply
 * carries fewer things.
 *
 * Column disclosure, by width:
 *   always   Order · Customer · Amount · Status · actions
 *   md  768  Created        (compacted to one relative line)
 *   lg 1024  Provider       (mark only once a real logo exists)
 *   xl 1280  Type
 *  2xl 1536  Agent · Vehicle
 *
 * So ~1100px renders 7 columns and 1440px renders 8, where both previously
 * rendered 10-11 and 1100px overflowed its container by ~200px.
 */
const CELL = "py-2";

interface OrderTableProps {
  items: OrderDTO[];
  emptyAction?: React.ReactNode;
  canDelete?: boolean;
  /** Show the tick boxes. They drive the bulk actions — export for every
   *  operator, delete for those allowed — so they are not tied to delete. */
  selectable?: boolean;
  /** Filters are applied: an empty list means "nothing matched", not "no
   *  orders exist". */
  filtered?: boolean;
}

export function OrderTable({
  items,
  emptyAction,
  canDelete = false,
  selectable = false,
  filtered = false,
}: OrderTableProps) {
  const router = useRouter();
  // Shared with the page's bulk actions (Export), so what is ticked here is
  // exactly what they act on.
  const { selected, toggle, setMany, clear } = useOrderSelection();
  const [pendingDelete, setPendingDelete] = useState<{
    ids: string[];
    bulk: boolean;
    /** Of those ids, how many are not on screen, and how many are paid. */
    offPage: number;
    paid: number;
  } | null>(null);
  const selectAllRef = useRef<HTMLButtonElement>(null);

  // Every row can be ticked, paid ones included: a paid order is precisely
  // what an operator exports charging data for. Delete still refuses them,
  // server-side, and says so.
  // The rows that can be ticked: all of them for Export, or — with the paid
  // features off — only the ones Delete can act on (never a paid order).
  const pageIds = useMemo(
    () =>
      items
        .filter((o) => PAID_FEATURES_ENABLED || o.status !== OrderStatus.PAID)
        .map((o) => o.id),
    [items],
  );
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const allSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const someSelected = selectedOnPage > 0 && !allSelected;
  // A selection survives paging, so some of it can be out of sight. Saying
  // how many keeps "Export 5 orders" from being a surprise.
  const offPage = selected.size - selectedOnPage;

  function toggleAll(checked: boolean) {
    setMany(pageIds, checked);
  }

  function toggleOne(id: string, checked: boolean) {
    toggle(id, checked);
  }

  function clearSelection() {
    clear();
    // Clear lives in the bar it removes; keep keyboard focus in the table.
    window.setTimeout(() => selectAllRef.current?.focus(), 0);
  }

  /** Ask before deleting what is ticked — saying what that includes. */
  function confirmBulkDelete() {
    const ids = Array.from(selected);
    setPendingDelete({
      ids,
      bulk: true,
      offPage,
      paid: items.filter((o) => selected.has(o.id) && o.status === OrderStatus.PAID)
        .length,
    });
  }

  async function onConfirmDelete() {
    if (!pendingDelete) return;
    try {
      const result = await api.post<{
        deleted: number;
        blockedPaidIds: string[];
      }>("/api/orders/delete", { ids: pendingDelete.ids });
      const blocked = result.blockedPaidIds?.length ?? 0;
      if (blocked > 0) {
        toast.success(
          `Deleted ${result.deleted}; skipped ${blocked} paid ${blocked === 1 ? "order" : "orders"}`,
        );
      } else {
        toast.success(
          pendingDelete.bulk
            ? `Deleted ${result.deleted} ${result.deleted === 1 ? "order" : "orders"}`
            : "Order deleted",
        );
      }
      // A bulk delete used the whole selection; a single row's delete only
      // takes that row out of it, so a selection built for an export (across
      // pages) survives deleting one unrelated order.
      if (pendingDelete.bulk) clear();
      else setMany(pendingDelete.ids, false);
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not delete";
      toast.error(message);
    }
  }

  const tooManyToDelete = selected.size > DELETE_MAX_SELECTION;
  const bulkBar =
    selectable && selected.size > 0 ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-border bg-surface-1 px-4 py-1.5 text-[13px]"
          data-testid="order-bulk-bar"
        >
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{selected.size}</span>{" "}
            selected
            {offPage > 0 ? (
              // Paging or a filter can hide ticked orders; they still count.
              <span className="text-muted-foreground">
                {` (${offPage} not on this page)`}
              </span>
            ) : null}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
            {canDelete ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={confirmBulkDelete}
                disabled={tooManyToDelete}
                title={
                  tooManyToDelete
                    ? `Delete up to ${DELETE_MAX_SELECTION} orders at a time`
                    : undefined
                }
              >
                <Trash2Icon className="size-3.5" />
                Delete selected
              </Button>
            ) : null}
          </div>
        </div>
      ) : null;

  if (items.length === 0) {
    const empty = (
      <EmptyState
        title={filtered ? "No orders match these filters" : "No orders yet"}
        description={
          filtered
            ? "Change the search or filters to see more orders."
            : "Create your first payable order to generate a payment link."
        }
        action={filtered ? undefined : emptyAction}
      />
    );
    // A filter can leave nothing on screen while orders are still ticked;
    // the count and Clear must stay reachable.
    return bulkBar ? (
      <div className="space-y-3">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {bulkBar}
        </div>
        {empty}
      </div>
    ) : (
      empty
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {bulkBar}
      {/* Slightly tighter outer gutter than the shared default, so the
          last laptop-width column fits without a horizontal scroll. */}
      <Table className="[&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4">
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead className="h-8 w-[36px]">
                <Checkbox
                  ref={selectAllRef}
                  checked={
                    allSelected ? true : someSelected ? "indeterminate" : false
                  }
                  onCheckedChange={(v) => toggleAll(v === true)}
                  disabled={pageIds.length === 0}
                  aria-label="Select all orders on this page"
                />
              </TableHead>
            ) : null}
            <TableHead className="h-8 w-[100px] xl:w-[116px]">Order</TableHead>
            <TableHead className="h-8">Customer</TableHead>
            <TableHead className="h-8 hidden 2xl:table-cell">Agent</TableHead>
            <TableHead className="h-8 hidden xl:table-cell">Type</TableHead>
            <TableHead className="h-8 hidden lg:table-cell w-[48px]">
              Provider
            </TableHead>
            <TableHead className="h-8 hidden 2xl:table-cell">Vehicle</TableHead>
            <TableHead className="h-8 text-right w-[92px]">Amount</TableHead>
            <TableHead className="h-8">Status</TableHead>
            <TableHead className="h-8 hidden md:table-cell w-[84px]">
              Created
            </TableHead>
            <TableHead className="h-8 w-[48px]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((o) => {
            const isPaid = o.status === OrderStatus.PAID;
            const isSelected = selected.has(o.id);
            const providerMeta = resolveProvider(o.provider);
            const hasProviderLogo =
              providerMeta.id !== UNKNOWN_PROVIDER.id &&
              providerMeta.logo !== UNKNOWN_PROVIDER.logo;
            return (
              <TableRow key={o.id} data-state={isSelected ? "selected" : undefined}>
                {selectable ? (
                  <TableCell className={CELL}>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(v) => toggleOne(o.id, v === true)}
                      // A paid order is selectable for Export (a paid
                      // feature). Without it, selection serves Delete alone,
                      // which never removes a paid order — as before.
                      disabled={!PAID_FEATURES_ENABLED && isPaid}
                      aria-label={`Select order ${o.orderNumber}`}
                    />
                  </TableCell>
                ) : null}
                <TableCell className={CELL}>
                  {/* Order numbers run to ~22 chars, which set the column's
                      width for every row. Truncate and keep the full value
                      in the tooltip and for copy/paste. */}
                  <Link
                    href={`/app/orders/${o.id}`}
                    title={o.orderNumber}
                    className="block max-w-[84px] xl:max-w-[100px] truncate font-mono text-[12px] font-medium text-foreground hover:underline"
                  >
                    {o.orderNumber}
                  </Link>
                  {o.state !== "ACTIVE" ? (
                    <Badge variant="muted" className="mt-0.5">
                      {o.state}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className={CELL}>
                  <div className="max-w-[116px] xl:max-w-[164px] truncate font-medium text-foreground text-[13px] leading-tight">
                    {o.customer.name}
                  </div>
                  <div
                    title={o.customer.email}
                    className="max-w-[116px] xl:max-w-[164px] truncate text-[11.5px] text-muted-foreground leading-tight"
                  >
                    {o.customer.email}
                  </div>
                </TableCell>
                {/* Who took the booking. Read straight off the order's own
                    creator snapshot — no user lookup, so no per-row query
                    and no way to reach another tenant's user. */}
                <TableCell
                  className={`hidden 2xl:table-cell text-[13px] leading-tight ${CELL}`}
                >
                  <span className="block max-w-[120px] truncate">
                    {resolveOrderAgent(o.createdBy)}
                  </span>
                </TableCell>
                <TableCell className={`hidden xl:table-cell ${CELL}`}>
                  <Badge variant="secondary">
                    {BookingTypeLabel[o.bookingType]}
                  </Badge>
                </TableCell>
                {/* The mark alone carries the brand once there is a real
                    logo, so the name beside it was pure duplication. A
                    provider still on the placeholder has nothing to
                    recognise, so that one keeps its name. */}
                <TableCell className={`hidden lg:table-cell max-w-[112px] xl:max-w-[128px] ${CELL}`}>
                  <span title={providerMeta.name}>
                    <ProviderBadge
                      provider={o.provider}
                      size="sm"
                      showName={!hasProviderLogo}
                    />
                  </span>
                </TableCell>
                <TableCell className={`hidden 2xl:table-cell ${CELL}`}>
                  <div className="max-w-[140px] truncate text-[13px] font-medium leading-tight">
                    {o.vehicle.company}
                  </div>
                  <div className="max-w-[140px] truncate text-[11.5px] text-muted-foreground leading-tight">
                    {o.vehicle.type}
                  </div>
                </TableCell>
                <TableCell
                  className={`text-right font-medium tabular-nums ${CELL}`}
                >
                  {formatCurrency(o.pricing.amount, o.pricing.currency)}
                </TableCell>
                <TableCell className={`whitespace-nowrap ${CELL}`}>
                  <div className="flex items-center gap-1">
                    <OrderStatusBadge status={o.status} />
                    {o.consent?.status &&
                    o.consent.status !== ConsentStatus.NOT_REQUESTED ? (
                      <ConsentStatusBadge status={o.consent.status} />
                    ) : null}
                    {/* Money taken that the order did not accept: whoever
                        picks this order up must not collect again. */}
                    {PAID_FEATURES_ENABLED && outstandingHeldPayments(o).length > 0 ? (
                      <Badge variant="destructive">Payment held</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell
                  className={`hidden md:table-cell whitespace-nowrap text-[11.5px] text-muted-foreground ${CELL}`}
                >
                  {/* Two stacked lines set the row height for the whole
                      table. The relative form is what gets scanned; the
                      absolute date stays available on hover. */}
                  <span title={formatDate(o.createdAt)}>
                    {formatRelative(o.createdAt)}
                  </span>
                </TableCell>
                <TableCell className={CELL}>
                  <div className="flex items-center justify-end gap-0.5">
                    {canDelete ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for order ${o.orderNumber}`}
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={isPaid}
                            onClick={() =>
                              setPendingDelete({ ids: [o.id], bulk: false, offPage: 0, paid: 0 })
                            }
                          >
                            <Trash2Icon className="size-3.5" />
                            Delete order
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link
                        href={`/app/orders/${o.id}`}
                        aria-label={`Open order ${o.orderNumber}`}
                      >
                        <ChevronRightIcon className="size-3.5" />
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        tone="destructive"
        icon={<Trash2Icon />}
        title={
          pendingDelete?.bulk
            ? `Delete ${pendingDelete.ids.length} ${pendingDelete.ids.length === 1 ? "order" : "orders"}?`
            : "Delete this order?"
        }
        description={
          // The selection outlives paging and filters, so say plainly when
          // it reaches orders that are not on screen.
          [
            "Orders are removed permanently.",
            pendingDelete?.bulk && pendingDelete.offPage > 0
              ? `${pendingDelete.offPage} of them ${pendingDelete.offPage === 1 ? "is" : "are"} not on this page.`
              : null,
            pendingDelete?.bulk && pendingDelete.paid > 0
              ? `${pendingDelete.paid} ${pendingDelete.paid === 1 ? "is" : "are"} paid and will be kept.`
              : "Paid orders are kept for financial history and will be skipped.",
          ]
            .filter(Boolean)
            .join(" ")
        }
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}
