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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { resolveProvider } from "@/lib/constants/providers";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { ConsentStatus, OrderStatus, ServiceType } from "@/lib/constants/enums";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDate, formatRelative, formatDateTime} from "@/lib/format";
import {
  describeServiceItem,
  serviceItemLabel,
  serviceTypeOf,
} from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

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

  /**
   * Header for the "what was bought" column. A list that is entirely one
   * service names it — "Vehicle" for the car-rental-only lists both
   * incumbent brands see, so their table header is unchanged — while a
   * mixed list falls back to the neutral "Item".
   */
  const itemColumnLabel = useMemo(() => {
    if (items.length === 0) return "Vehicle";
    const labels = new Set(items.map((o) => serviceItemLabel(o)));
    return labels.size === 1 ? [...labels][0] : "Item";
  }, [items]);
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
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-1 px-4 py-2 text-sm">
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
      {/* Density is applied HERE rather than in components/ui/table.tsx,
          which is shared by the users, providers, audit and car-link tables —
          editing the primitive would silently restyle all of them.
          `[&_td]` / `[&_th]` scope the tightened padding to this table only. */}
      <Table className="[&_td]:px-2.5 [&_td]:py-1.5 [&_th]:px-2.5 [&_th]:pb-1.5 [&_th]:h-8">
        <TableHeader>
          <TableRow>
            {canDelete ? (
              <TableHead className="w-[36px]">
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
            <TableHead className="w-[124px]">Order</TableHead>
            <TableHead className="min-w-[150px]">Customer</TableHead>
            {/* Type is the first thing to go as width tightens: it is a
                low-cardinality badge and the value is repeated on the detail
                page. Promoted back at 2xl where there is room again. */}
            <TableHead className="hidden 2xl:table-cell w-[120px]">Type</TableHead>
            {/* Provider becomes a logo-only column, so it needs far less
                width and can appear EARLIER than before (md, was lg). */}
            <TableHead className="hidden md:table-cell w-[52px]">
              <span className="sr-only">Provider</span>
            </TableHead>
            <TableHead className="hidden xl:table-cell min-w-[120px]">
              {itemColumnLabel}
            </TableHead>
            <TableHead className="text-right w-[104px]">Amount</TableHead>
            <TableHead className="w-[150px]">Status</TableHead>
            <TableHead className="hidden lg:table-cell w-[92px]">Created</TableHead>
            <TableHead className="w-[56px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((o) => {
            const isPaid = o.status === OrderStatus.PAID;
            const isSelected = selected.has(o.id);
            return (
              <TableRow key={o.id} data-state={isSelected ? "selected" : undefined}>
                {canDelete ? (
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(v) => toggleOne(o.id, v === true)}
                      disabled={isPaid}
                      aria-label={`Select order ${o.orderNumber}`}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  {/* Order numbers are long and monospaced. Truncating with
                      the full value in a tooltip keeps the column narrow
                      without losing the identifier — it stays selectable in
                      the tooltip and is the link target either way. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={`/app/orders/${o.id}`}
                        className="block max-w-[112px] truncate font-mono text-[12px] font-medium text-foreground hover:underline"
                      >
                        {o.orderNumber}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="font-mono">
                      {o.orderNumber}
                    </TooltipContent>
                  </Tooltip>
                  {o.state !== "ACTIVE" ? (
                    <Badge variant="muted" className="mt-1">
                      {o.state}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-[220px]">
                  <div
                    className="truncate font-medium text-foreground text-[13px] leading-tight"
                    title={o.customer.name}
                  >
                    {o.customer.name}
                  </div>
                  <div
                    className="truncate text-[11.5px] text-muted-foreground leading-tight"
                    title={o.customer.email}
                  >
                    {o.customer.email}
                  </div>
                </TableCell>
                <TableCell className="hidden 2xl:table-cell">
                  <Badge variant="secondary">
                    {BookingTypeLabel[o.bookingType]}
                  </Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {/* Logo only. The name beside a recognisable brand mark was
                      pure duplication and the widest thing in the row; the
                      tooltip and the img alt keep it available and
                      accessible. Dropping it is what lets this column appear
                      at md instead of lg. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <ProviderBadge
                          provider={o.provider}
                          showName={false}
                          size="sm"
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {resolveProvider(o.provider).name}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="hidden xl:table-cell max-w-[180px]">
                  {serviceTypeOf(o) === ServiceType.CAR_RENTAL && o.vehicle ? (
                    <>
                      <div
                        className="truncate text-[13px] font-medium leading-tight"
                        title={o.vehicle.company}
                      >
                        {o.vehicle.company}
                      </div>
                      <div
                        className="truncate text-[11.5px] text-muted-foreground leading-tight"
                        title={o.vehicle.type}
                      >
                        {o.vehicle.type}
                      </div>
                    </>
                  ) : (
                    <div
                      className="truncate text-[13px] font-medium leading-tight"
                      title={describeServiceItem(o)}
                    >
                      {describeServiceItem(o)}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatCurrency(o.pricing.amount, o.pricing.currency)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <OrderStatusBadge status={o.status} />
                    {o.consent?.status &&
                    o.consent.status !== ConsentStatus.NOT_REQUESTED ? (
                      <ConsentStatusBadge status={o.consent.status} />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-[11.5px] text-muted-foreground">
                  {/* One line instead of two — the two-line stack was the
                      single biggest contributor to row height. The relative
                      time and the exact timestamp both live in the tooltip,
                      so nothing is lost. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="whitespace-nowrap tabular-nums">
                        {formatDate(o.createdAt, { year: undefined })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {formatDateTime(o.createdAt)} · {formatRelative(o.createdAt)}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
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
