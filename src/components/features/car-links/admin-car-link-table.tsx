"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon, ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import type { CarLinkDTO } from "@/types";

interface AdminCarLinkTableProps {
  initialItems: CarLinkDTO[];
}

/**
 * Workspace catalog of car links. Admin-only edit / deactivate /
 * restore controls. Read-mostly: most edits happen inline in the
 * order form via the selector.
 */
export function AdminCarLinkTable({ initialItems }: AdminCarLinkTableProps) {
  const router = useRouter();
  const [items, setItems] = React.useState(initialItems);
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  async function setActive(id: string, active: boolean) {
    setPendingId(id);
    try {
      const updated = active
        ? await api.del<CarLinkDTO>(`/api/car-links/${id}?restore=1`)
        : await api.del<CarLinkDTO>(`/api/car-links/${id}`);
      setItems((prev) => prev.map((p) => (p.id === id ? updated : p)));
      toast.success(active ? "Restored" : "Removed from library");
      router.refresh();
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Update failed";
      toast.error(msg);
    } finally {
      setPendingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No car links yet"
        description="Staff can add to the library inline while creating an order."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Make &amp; model</TableHead>
            <TableHead>Link</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead>Added by</TableHead>
            <TableHead className="w-[120px] text-right">Status</TableHead>
            <TableHead className="w-[110px] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((link) => (
            <TableRow key={link.id} className={!link.active ? "opacity-60" : undefined}>
              <TableCell>
                <div className="text-[13px] font-medium text-foreground">
                  {link.label}
                </div>
              </TableCell>
              <TableCell>
                <a
                  href={link.imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12.5px] text-foreground/80 hover:text-foreground hover:underline"
                >
                  <span className="max-w-[260px] truncate">{link.imageUrl}</span>
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </a>
              </TableCell>
              <TableCell className="max-w-[220px]">
                <div className="line-clamp-2 text-[12px] text-muted-foreground">
                  {link.notes ?? "—"}
                </div>
              </TableCell>
              <TableCell>
                <div className="text-[12px] text-muted-foreground">
                  {link.createdBy.name}
                </div>
              </TableCell>
              <TableCell className="text-right text-[12px]">
                {link.active ? (
                  <span className="text-emerald-700">Active</span>
                ) : (
                  <span className="text-muted-foreground">Archived</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant={link.active ? "ghost" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-[12px]"
                  onClick={() => setActive(link.id, !link.active)}
                  disabled={pendingId === link.id}
                >
                  {link.active ? (
                    <>
                      <ArchiveIcon className="size-3.5" />
                      Archive
                    </>
                  ) : (
                    <>
                      <ArchiveRestoreIcon className="size-3.5" />
                      Restore
                    </>
                  )}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
