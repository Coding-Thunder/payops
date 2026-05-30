"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MoreHorizontalIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { EmptyState } from "@/components/common/empty-state";
import { RecordStateBadge } from "@/components/common/status-badges";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { RecordState } from "@/lib/constants/enums";
import { formatCurrency, formatRelative } from "@/lib/format";
import type { ItemDTO } from "@/server/services/item.service";

interface ItemTableProps {
  items: ItemDTO[];
}

export function ItemTable({ items }: ItemTableProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(it: ItemDTO, next: RecordState): Promise<void> {
    setBusyId(it.id);
    try {
      await api.patch(`/api/admin/items/${it.id}`, { status: next });
      toast.success(
        next === RecordState.ACTIVE
          ? `${it.name} restored`
          : `${it.name} archived`,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Could not update");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No catalog items yet"
        description="Save your most-sold products once here, then operators can pick them on every order without re-typing."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>SKU</TableHead>
          <TableHead>Item type</TableHead>
          <TableHead>Base price</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-12" aria-label="Actions" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((it) => (
          <TableRow key={it.id}>
            <TableCell>
              <Link
                href={`/app/admin/items/${it.id}`}
                className="font-medium hover:underline"
              >
                {it.name}
              </Link>
              {it.description ? (
                <div className="text-[11.5px] text-muted-foreground line-clamp-1">
                  {it.description}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              {it.sku ? (
                <code className="text-[12px]">{it.sku}</code>
              ) : (
                <span className="text-muted-foreground/60">—</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant="secondary" className="font-mono text-[11px]">
                {it.itemTypeKey}
              </Badge>
            </TableCell>
            <TableCell>
              {it.basePrice ? (
                <span className="tabular-nums">
                  {formatCurrency(it.basePrice.amount, it.basePrice.currency)}
                </span>
              ) : (
                <span className="text-muted-foreground/60">Per order</span>
              )}
            </TableCell>
            <TableCell>
              <RecordStateBadge state={it.status} />
            </TableCell>
            <TableCell className="text-[12px] text-muted-foreground">
              {formatRelative(it.updatedAt)}
            </TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Actions"
                    disabled={busyId === it.id}
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{it.name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href={`/app/admin/items/${it.id}`}>Edit</Link>
                  </DropdownMenuItem>
                  {it.status === RecordState.ACTIVE ? (
                    <DropdownMenuItem
                      onClick={() => setStatus(it, RecordState.ARCHIVED)}
                    >
                      Archive
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() => setStatus(it, RecordState.ACTIVE)}
                    >
                      Restore
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
