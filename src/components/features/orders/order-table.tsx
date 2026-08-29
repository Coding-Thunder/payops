"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
}

export function OrderTable({ items, emptyAction, canDelete = false }: OrderTableProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<{
    ids: string[];
    bulk: boolean;
  } | null>(null);

  const selectableItems = useMemo(
    () => items.filter((o) => o.status !== OrderStatus.PAID),
    [items],
  );
  const allSelected =
    selectableItems.length > 0 &&
    selectableItems.every((i) => selected.has(i.id));
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectableItems.map((i) => i.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
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
      setSelected(new Set());
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not delete";
      toast.error(message);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        description="Create your first payable order to generate a payment link."
        action={emptyAction}
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {canDelete && selected.size > 0 ? (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-1 px-4 py-1.5 text-[13px]">
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{selected.size}</span>{" "}
            selected
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                setPendingDelete({ ids: Array.from(selected), bulk: true })
              }
            >
              <Trash2Icon className="size-3.5" />
              Delete selected
            </Button>
          </div>
        </div>
      ) : null}
      {/* Slightly tighter outer gutter than the shared default, so the
          last laptop-width column fits without a horizontal scroll. */}
      <Table className="[&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4">
        <TableHeader>
          <TableRow>
            {canDelete ? (
              <TableHead className="h-8 w-[36px]">
                <Checkbox
                  checked={
                    allSelected ? true : someSelected ? "indeterminate" : false
                  }
                  onCheckedChange={(v) => toggleAll(v === true)}
                  disabled={selectableItems.length === 0}
                  aria-label="Select all rows"
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
            <TableHead className="h-8 w-[48px]" />
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
                {canDelete ? (
                  <TableCell className={CELL}>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(v) => toggleOne(o.id, v === true)}
                      disabled={isPaid}
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
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={isPaid}
                            onClick={() =>
                              setPendingDelete({ ids: [o.id], bulk: false })
                            }
                          >
                            <Trash2Icon className="size-3.5" />
                            Delete order
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link href={`/app/orders/${o.id}`}>
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
        description="Orders are removed permanently. Paid orders are kept for financial history and will be skipped."
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}
