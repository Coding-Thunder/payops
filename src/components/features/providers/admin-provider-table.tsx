"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MoreHorizontalIcon } from "lucide-react";

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
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { RecordState } from "@/lib/constants/enums";
import { formatRelative } from "@/lib/format";
import type { ProviderDTO } from "@/types";

import { EditProviderDialog } from "./edit-provider-dialog";
import { ProviderLogo } from "./provider-logo";

interface AdminProviderTableProps {
  items: ProviderDTO[];
}

export function AdminProviderTable({ items }: AdminProviderTableProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<ProviderDTO | null>(null);
  const [archiving, setArchiving] = useState<ProviderDTO | null>(null);

  async function toggleStatus(p: ProviderDTO) {
    const next =
      p.status === RecordState.ACTIVE ? RecordState.DISABLED : RecordState.ACTIVE;
    try {
      await api.patch(`/api/admin/providers/${p.id}/status`, { status: next });
      toast.success(
        next === RecordState.ACTIVE
          ? `${p.name} enabled`
          : `${p.name} disabled`,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not update provider";
      toast.error(message);
    }
  }

  async function archive(p: ProviderDTO) {
    try {
      await api.del(`/api/admin/providers/${p.id}`);
      toast.success(`${p.name} archived`);
      setArchiving(null);
      startTransition(() => router.refresh());
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not archive provider";
      toast.error(message);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No providers configured"
        description="Add your first rental provider to start creating orders against it."
      />
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[58px]" />
              <TableHead>Provider</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Updated</TableHead>
              <TableHead className="w-[40px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <ProviderLogo
                    provider={{ id: p.key, name: p.name, logo: p.logo }}
                    size="md"
                    framed
                  />
                </TableCell>
                <TableCell>
                  <div className="font-medium text-[13px] leading-tight">
                    {p.name}
                  </div>
                  {p.tagline ? (
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground leading-tight">
                      {p.tagline}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <code className="rounded bg-surface-1 px-1.5 py-0.5 text-[11.5px] text-muted-foreground">
                    {p.key}
                  </code>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-4 rounded ring-1 ring-black/10"
                      style={{ backgroundColor: p.primaryColor }}
                    />
                    <span className="font-mono text-[11.5px] text-muted-foreground">
                      {p.primaryColor.toUpperCase()}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <RecordStateBadge state={p.status} />
                </TableCell>
                <TableCell className="hidden lg:table-cell text-[11.5px] text-muted-foreground">
                  {formatRelative(p.updatedAt)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm">
                        <MoreHorizontalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => setEditing(p)}>
                        Edit details
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggleStatus(p)}>
                        {p.status === RecordState.ACTIVE
                          ? "Disable"
                          : "Enable"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={p.status === RecordState.ARCHIVED}
                        onClick={() => setArchiving(p)}
                      >
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing ? (
        <EditProviderDialog
          provider={editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      ) : null}

      {archiving ? (
        <ConfirmDialog
          open={!!archiving}
          onOpenChange={(o) => !o && setArchiving(null)}
          title={`Archive ${archiving.name}?`}
          description="Archived providers are hidden from order creation. Existing orders that reference this brand keep their snapshot — receipts and dashboards continue to work."
          confirmLabel="Archive provider"
          tone="destructive"
          onConfirm={() => archive(archiving)}
        />
      ) : null}
    </>
  );
}
