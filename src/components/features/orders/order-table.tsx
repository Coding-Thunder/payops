"use client";

import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { EmptyState } from "@/components/common/empty-state";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { formatCurrency, formatDate, formatRelative } from "@/lib/format";
import type { OrderDTO } from "@/types";

interface OrderTableProps {
  items: OrderDTO[];
  emptyAction?: React.ReactNode;
}

export function OrderTable({ items, emptyAction }: OrderTableProps) {
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">Order</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead className="hidden md:table-cell">Type</TableHead>
            <TableHead className="hidden lg:table-cell">Vehicle</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Created</TableHead>
            <TableHead className="w-[36px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((o) => (
            <TableRow key={o.id}>
              <TableCell>
                <Link
                  href={`/orders/${o.id}`}
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
                <OrderStatusBadge status={o.status} />
              </TableCell>
              <TableCell className="hidden md:table-cell text-[11.5px] text-muted-foreground">
                <div>{formatDate(o.createdAt)}</div>
                <div>{formatRelative(o.createdAt)}</div>
              </TableCell>
              <TableCell>
                <Button asChild variant="ghost" size="icon-sm">
                  <Link href={`/orders/${o.id}`}>
                    <ChevronRightIcon className="size-3.5" />
                  </Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
