"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { toast } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { api, ApiClientError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import type { AuditLogDTO } from "@/types";

interface AuditLogTableProps {
  items: AuditLogDTO[];
  canDelete: boolean;
}

export function AuditLogTable({ items, canDelete }: AuditLogTableProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<{
    ids: string[];
    bulk: boolean;
  } | null>(null);

  const allSelected = useMemo(
    () => items.length > 0 && items.every((i) => selected.has(i.id)),
    [items, selected],
  );
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(items.map((i) => i.id)) : new Set());
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
      const result = await api.del<{ deleted: number }>(
        "/api/admin/audit-logs",
        { ids: pendingDelete.ids },
      );
      toast.success(
        pendingDelete.bulk
          ? `Deleted ${result.deleted} audit ${result.deleted === 1 ? "entry" : "entries"}`
          : "Audit entry deleted",
      );
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
      <div className="p-6">
        <EmptyState
          title="No audit entries yet"
          description="Audit entries are created automatically as users and customers interact with the system."
        />
      </div>
    );
  }

  return (
    <>
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
                  aria-label="Select all rows"
                />
              </TableHead>
            ) : null}
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead className="hidden md:table-cell">Details</TableHead>
            {canDelete ? <TableHead className="w-[40px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((row) => {
            const isSelected = selected.has(row.id);
            return (
              <TableRow key={row.id} data-state={isSelected ? "selected" : undefined}>
                {canDelete ? (
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(v) => toggleOne(row.id, v === true)}
                      aria-label={`Select audit entry ${row.id}`}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDateTime(row.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {row.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <div className="font-medium">{row.entityType}</div>
                  {row.entityId ? (
                    <div className="font-mono text-muted-foreground">
                      {row.entityId}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs">
                  {row.actorName ?? "system"}
                  {row.actorRole ? (
                    <span className="ml-1 text-muted-foreground">
                      ({row.actorRole})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-md truncate">
                  {row.metadata ? JSON.stringify(row.metadata) : "—"}
                </TableCell>
                {canDelete ? (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontalIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            setPendingDelete({ ids: [row.id], bulk: false })
                          }
                        >
                          <Trash2Icon className="size-3.5" />
                          Delete entry
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                ) : null}
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
            ? `Delete ${pendingDelete.ids.length} audit ${pendingDelete.ids.length === 1 ? "entry" : "entries"}?`
            : "Delete this audit entry?"
        }
        description="Audit entries are removed permanently. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </>
  );
}
