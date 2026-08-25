"use client";

import * as React from "react";
import Link from "next/link";
import {
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  MailIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiClientError } from "@/lib/api-client";
import {
  LINK_FILTERS,
  LINK_FILTER_LABELS,
  type LinkFilter,
} from "@/lib/constants/client-resources";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useClientLinks, useInvalidateResources } from "@/hooks/use-client-resources";
import type { ClientLinkDTO } from "@/types";

import { AddLinkDialog } from "./add-link-dialog";
import type { OrderOption } from "./add-file-dialog";

interface LinksPanelProps {
  customerId: string;
  orderId?: string | null;
  orderNumber?: string | null;
  orderOptions?: OrderOption[];
  canManage: boolean;
  /** Controlled "add link" entry point, so another surface (an
   *  over-size upload) can drop the operator straight into this form. */
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * The Links section — a peer of Files, never a sub-mode of it.
 *
 * Keeping them separate is the product decision, not a layout one: a
 * file is a document TraceTxn holds; a link is a resource it points at.
 * Collapsing "add link" into the upload flow would teach operators that
 * links are a fallback for failed uploads, when in practice they're how
 * most large deliverables actually travel.
 */
export function LinksPanel({
  customerId,
  orderId = null,
  orderNumber = null,
  orderOptions = [],
  canManage,
  addOpen,
  onAddOpenChange,
  className,
}: LinksPanelProps) {
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [filter, setFilter] = React.useState<LinkFilter>("all");
  const [editing, setEditing] = React.useState<ClientLinkDTO | null>(null);
  const [deleting, setDeleting] = React.useState<ClientLinkDTO | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  const invalidate = useInvalidateResources();

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data: links, isLoading, error } = useClientLinks({
    customerId,
    orderId: orderId ?? undefined,
    filter,
    q: debouncedSearch || undefined,
  });

  const filters = orderId
    ? LINK_FILTERS.filter((f) => f !== "order")
    : LINK_FILTERS;

  async function handleDelete() {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await api.del(`/api/links/${deleting.id}`);
      toast.success(`Removed ${deleting.name}`);
      setDeleting(null);
      invalidate();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Couldn't remove that link",
      );
    } finally {
      setDeletePending(false);
    }
  }

  const isFiltered = filter !== "all" || debouncedSearch.length > 0;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by link name"
            className="pl-8"
            aria-label="Search links"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as LinkFilter)}>
          <SelectTrigger className="w-[180px]" aria-label="Filter links">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filters.map((f) => (
              <SelectItem key={f} value={f}>
                {LINK_FILTER_LABELS[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage ? (
          <AddLinkDialog
            customerId={customerId}
            lockedOrderId={orderId}
            lockedOrderNumber={orderNumber}
            orderOptions={orderOptions}
            onSaved={invalidate}
            open={addOpen}
            onOpenChange={onAddOpenChange}
          />
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          title="Couldn't load links"
          description={
            error instanceof ApiClientError
              ? error.message
              : "Something went wrong fetching this client's links."
          }
        />
      ) : !links || links.length === 0 ? (
        <EmptyState
          icon={<LinkIcon className="size-4" />}
          title={isFiltered ? "No matching links" : "No links yet"}
          description={
            isFiltered
              ? "Try a different search or filter."
              : "Large videos, Drive folders, prototypes, dashboards — the resources that live outside TraceTxn."
          }
          action={
            canManage && !isFiltered ? (
              <AddLinkDialog
                customerId={customerId}
                lockedOrderId={orderId}
                lockedOrderNumber={orderNumber}
                orderOptions={orderOptions}
                onSaved={invalidate}
                variant="outline"
              />
            ) : null
          }
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {links.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              showOrder={!orderId}
              canManage={canManage}
              onEdit={() => setEditing(link)}
              onDelete={() => setDeleting(link)}
            />
          ))}
        </ul>
      )}

      {editing ? (
        <AddLinkDialog
          customerId={customerId}
          lockedOrderId={orderId}
          lockedOrderNumber={orderNumber}
          orderOptions={orderOptions}
          link={editing}
          hideTrigger
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title="Remove this link?"
        description={
          deleting
            ? `"${deleting.name}" is removed from this client's Links. The resource itself is untouched — TraceTxn only stored the address.`
            : undefined
        }
        tone="destructive"
        confirmLabel="Remove link"
        pending={deletePending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function LinkRow({
  link,
  showOrder,
  canManage,
  onEdit,
  onDelete,
}: {
  link: ClientLinkDTO;
  showOrder: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <li className="flex items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/20">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-foreground ring-1 ring-inset ring-border">
        <LinkIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="truncate text-[13px] font-medium text-foreground hover:underline"
          >
            {link.name}
          </a>
          {showOrder && link.orderId ? (
            <Link
              href={`/app/orders/${link.orderId}`}
              className="text-[11.5px] font-medium text-foreground/80 hover:underline"
            >
              {link.orderNumber ?? "Order"}
            </Link>
          ) : null}
          {link.lastEmailedAt ? (
            <span
              className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground"
              title={`Shared via email ${formatDateTime(link.lastEmailedAt)}`}
            >
              <MailIcon className="size-3" aria-hidden />
              Shared via email
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground">
          <span className="font-medium text-foreground/70">{link.source}</span>
          <span aria-hidden>·</span>
          <span title={formatDateTime(link.createdAt)}>
            Added {formatRelative(link.createdAt)}
          </span>
          <span aria-hidden>·</span>
          <span>
            {link.addedBy.actorType === "CLIENT"
              ? `Shared by Client · saved by ${link.addedBy.name}`
              : `by ${link.addedBy.name}`}
          </span>
        </p>
        {link.description ? (
          <p className="mt-1 text-[12px] text-muted-foreground">
            {link.description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2">
          <a href={link.url} target="_blank" rel="noopener noreferrer nofollow">
            <ExternalLinkIcon className="size-3.5" />
            <span className="sr-only sm:not-sr-only">Open</span>
          </a>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0"
              aria-label={`More actions for ${link.name}`}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void copy()}>
              <CopyIcon className="size-3.5" />
              Copy link
            </DropdownMenuItem>
            {canManage ? (
              <>
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilIcon className="size-3.5" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2Icon className="size-3.5" />
                  Remove
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
