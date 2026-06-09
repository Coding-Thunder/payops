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
import { formatRelative } from "@/lib/format";
import type { ItemTypeDTO } from "@/server/services/item-type.service";

interface ItemTypeTableProps {
  items: ItemTypeDTO[];
}

export function ItemTypeTable({ items }: ItemTypeTableProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(it: ItemTypeDTO, next: RecordState): Promise<void> {
    setBusyId(it.id);
    try {
      await api.patch(`/api/admin/item-types/${it.id}`, { status: next });
      toast.success(
        next === RecordState.ACTIVE
          ? `${it.name} restored`
          : `${it.name} archived`,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not update";
      toast.error(message);
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No item types yet"
        description="Define what kinds of orders your business sells. Each item type drives a dynamic create-order form and (optionally) an email block layout."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Pricing</TableHead>
          <TableHead>Attributes</TableHead>
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
                href={`/app/admin/item-types/${it.id}`}
                className="font-medium hover:underline"
              >
                {it.name}
              </Link>
              {it.description ? (
                <div className="text-[11.5px] text-muted-foreground">
                  {it.description}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              <code className="text-[12px]">{it.key}</code>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{it.pricingModel}</Badge>
              {it.requiresScheduling ? (
                <Badge variant="outline" className="ml-1">
                  Scheduled
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>{it.attributeSchema.length}</TableCell>
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
                    <Link href={`/app/admin/item-types/${it.id}`}>Edit</Link>
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
