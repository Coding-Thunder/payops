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
import { BookingTypeLabel } from "@/lib/constants/labels";
import { ConsentStatus, OrderStatus } from "@/lib/constants/enums";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDate, formatRelative } from "@/lib/format";
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
        description="Create your first payable order to generate a Stripe payment link."
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
      <Table>
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
            <TableHead className="w-[180px]">Order</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead className="hidden md:table-cell">Type</TableHead>
            <TableHead className="hidden lg:table-cell">Provider</TableHead>
            <TableHead className="hidden xl:table-cell">Vehicle</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Created</TableHead>
            <TableHead className="w-[72px]" />
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
                  <Link
                    href={`/app/orders/${o.id}`}
                    className="font-mono text-[12px] font-medium text-foreground hover:underline"
                  >
                    {o.orderNumber}
                  </Link>
                  {o.state !== "ACTIVE" ? (
                    <div className="mt-1">
                      <Badge variant="muted">{o.state}</Badge>
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <div className="font-medium text-foreground text-[13px] leading-tight">
                    {o.customer.name}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground leading-tight mt-0.5">
                    {o.customer.email}
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <Badge variant="secondary">
                    {BookingTypeLabel[o.bookingType]}
                  </Badge>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <ProviderBadge provider={o.provider} size="sm" />
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  <div className="text-[13px] font-medium leading-tight">
                    {o.vehicle.company}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground leading-tight mt-0.5">
                    {o.vehicle.type}
                  </div>
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
                <TableCell className="hidden md:table-cell text-[11.5px] text-muted-foreground">
                  <div>{formatDate(o.createdAt)}</div>
                  <div>{formatRelative(o.createdAt)}</div>
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
