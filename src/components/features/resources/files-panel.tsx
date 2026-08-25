"use client";

import * as React from "react";
import Link from "next/link";
import {
  DownloadIcon,
  MailIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";
import {
  FILE_FILTERS,
  FILE_FILTER_LABELS,
  FILE_VISIBILITY_LABELS,
  FileVisibility,
  RESOURCE_ACTOR_LABELS,
  formatFileSize,
  type FileFilter,
} from "@/lib/constants/client-resources";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useClientFiles, useInvalidateResources } from "@/hooks/use-client-resources";
import type { ClientFileDTO } from "@/types";

import { AddFileDialog, type OrderOption } from "./add-file-dialog";
import { AddLinkDialog } from "./add-link-dialog";
import { FileTypeIcon } from "./file-type-icon";

interface FilesPanelProps {
  customerId: string;
  /** Set when mounted inside an order. Scopes the list to that order
   *  and pre-fills the relationship on every upload. */
  orderId?: string | null;
  orderNumber?: string | null;
  /** Client scope only: the orders an upload can be related to. */
  orderOptions?: OrderOption[];
  canManage: boolean;
  /** Whether the over-size escape hatch may create a link. Without it
   *  the guidance still explains what to do; it just can't do it here. */
  canManageLinks?: boolean;
  className?: string;
}

const NO_ORDER = "none";

/**
 * The Files section. One component, two scopes:
 *
 *   Client Files → every file for the client, order-related ones
 *                  included.
 *   Order Files  → only the files related to that order.
 *
 * Both read the same collection through the same endpoint; the scope is
 * a filter, never a copy. That's what lets a proposal attached to the
 * Website Development order also show up in the client's Files without
 * existing twice.
 */
export function FilesPanel({
  customerId,
  orderId = null,
  orderNumber = null,
  orderOptions = [],
  canManage,
  canManageLinks = false,
  className,
}: FilesPanelProps) {
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [filter, setFilter] = React.useState<FileFilter>("all");
  const [editing, setEditing] = React.useState<ClientFileDTO | null>(null);
  const [deleting, setDeleting] = React.useState<ClientFileDTO | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  // The over-size hand-off. A 300 MB video isn't a mistake to scold
  // someone for, it's a Link — so offer to create one right here rather
  // than sending the operator to another tab to start over.
  const [linkFallbackOpen, setLinkFallbackOpen] = React.useState(false);
  const invalidate = useInvalidateResources();

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const scope = {
    customerId,
    orderId: orderId ?? undefined,
    filter,
    q: debouncedSearch || undefined,
  };
  const { data: files, isLoading, error } = useClientFiles(scope);

  // Inside an order every row is order-related by definition, so the
  // "Related to order" filter would be a no-op chip. Drop it.
  const filters = orderId
    ? FILE_FILTERS.filter((f) => f !== "order")
    : FILE_FILTERS;

  async function handleDelete() {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await api.del(`/api/files/${deleting.id}`);
      toast.success(`Removed ${deleting.fileName}`);
      setDeleting(null);
      invalidate();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Couldn't remove that file",
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
            placeholder="Search by file name"
            className="pl-8"
            aria-label="Search files"
          />
        </div>
        <Select
          value={filter}
          onValueChange={(v) => setFilter(v as FileFilter)}
        >
          <SelectTrigger className="w-[190px]" aria-label="Filter files">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filters.map((f) => (
              <SelectItem key={f} value={f}>
                {FILE_FILTER_LABELS[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage ? (
          <AddFileDialog
            customerId={customerId}
            lockedOrderId={orderId}
            lockedOrderNumber={orderNumber}
            orderOptions={orderOptions}
            onCreated={invalidate}
            onSwitchToLink={
              canManageLinks ? () => setLinkFallbackOpen(true) : undefined
            }
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
          title="Couldn't load files"
          description={
            error instanceof ApiClientError
              ? error.message
              : "Something went wrong fetching this client's files."
          }
        />
      ) : !files || files.length === 0 ? (
        <EmptyState
          title={isFiltered ? "No matching files" : "No files yet"}
          description={
            isFiltered
              ? "Try a different search or filter."
              : orderId
                ? "Documents attached to this order will appear here."
                : "Proposals, contracts, reports, and anything else shared during this relationship."
          }
          action={
            canManage && !isFiltered ? (
              <AddFileDialog
                customerId={customerId}
                lockedOrderId={orderId}
                lockedOrderNumber={orderNumber}
                orderOptions={orderOptions}
                onCreated={invalidate}
                onSwitchToLink={
                  canManageLinks ? () => setLinkFallbackOpen(true) : undefined
                }
                variant="outline"
              />
            ) : null
          }
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              showOrder={!orderId}
              canManage={canManage}
              onEdit={() => setEditing(file)}
              onDelete={() => setDeleting(file)}
            />
          ))}
        </ul>
      )}

      {canManageLinks ? (
        <AddLinkDialog
          customerId={customerId}
          lockedOrderId={orderId}
          lockedOrderNumber={orderNumber}
          orderOptions={orderOptions}
          hideTrigger
          open={linkFallbackOpen}
          onOpenChange={setLinkFallbackOpen}
          onSaved={() => {
            toast.success("Saved to Links");
            invalidate();
          }}
        />
      ) : null}

      <EditFileDialog
        file={editing}
        orderOptions={orderOptions}
        lockedOrderId={orderId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidate();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title="Remove this file?"
        description={
          deleting
            ? `"${deleting.fileName}" will no longer be available to download. The Timeline keeps the record that it was shared.`
            : undefined
        }
        tone="destructive"
        confirmLabel="Remove file"
        pending={deletePending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function FileRow({
  file,
  showOrder,
  canManage,
  onEdit,
  onDelete,
}: {
  file: ClientFileDTO;
  showOrder: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta: React.ReactNode[] = [
    <span key="type" className="uppercase">
      {file.extension}
    </span>,
    <span key="size">{formatFileSize(file.sizeBytes)}</span>,
    <span key="added" title={formatDateTime(file.createdAt)}>
      Added {formatRelative(file.createdAt)}
    </span>,
    <span key="by">
      {file.addedBy.actorType === "CLIENT"
        ? `${RESOURCE_ACTOR_LABELS.CLIENT} · saved by ${file.addedBy.name}`
        : `by ${file.addedBy.name}`}
    </span>,
  ];

  return (
    <li className="flex items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/20">
      <FileTypeIcon extension={file.extension} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[13px] font-medium text-foreground">
            {file.fileName}
          </span>
          <Badge variant={file.visibility === "SHARED" ? "info" : "muted"}>
            {FILE_VISIBILITY_LABELS[file.visibility as FileVisibility]}
          </Badge>
          {showOrder && file.orderId ? (
            <Link
              href={`/app/orders/${file.orderId}`}
              className="text-[11.5px] font-medium text-foreground/80 hover:underline"
            >
              {file.orderNumber ?? "Order"}
            </Link>
          ) : null}
          {file.lastEmailedAt ? (
            <span
              className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground"
              title={`Sent via email ${formatDateTime(file.lastEmailedAt)}`}
            >
              <MailIcon className="size-3" aria-hidden />
              Sent via email
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground">
          {meta.map((node, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              {node}
            </React.Fragment>
          ))}
        </p>
        {file.description ? (
          <p className="mt-1 text-[12px] text-muted-foreground">
            {file.description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2">
          {/* Plain anchor, not next/link: this is a byte stream the
              browser must hand to the OS, not a route transition. */}
          <a href={file.downloadUrl} download>
            <DownloadIcon className="size-3.5" />
            <span className="sr-only sm:not-sr-only">Download</span>
          </a>
        </Button>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                aria-label={`More actions for ${file.fileName}`}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <PencilIcon className="size-3.5" />
                Edit details
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2Icon className="size-3.5" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}

function EditFileDialog({
  file,
  orderOptions,
  lockedOrderId,
  onClose,
  onSaved,
}: {
  file: ClientFileDTO | null;
  orderOptions: OrderOption[];
  lockedOrderId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = React.useState("");
  const [visibility, setVisibility] = React.useState<FileVisibility>(
    FileVisibility.INTERNAL,
  );
  const [orderId, setOrderId] = React.useState(NO_ORDER);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const uid = React.useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  // Seed once per file the dialog is opened for, not on every render —
  // otherwise a background refetch would overwrite what's being typed.
  const seededFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!file) {
      seededFor.current = null;
      return;
    }
    if (file.id !== seededFor.current) {
      seededFor.current = file.id;
      setDescription(file.description ?? "");
      setVisibility(file.visibility as FileVisibility);
      setOrderId(file.orderId ?? NO_ORDER);
      setError(null);
    }
  }, [file]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/files/${file.id}`, {
        description: description.trim() || null,
        visibility,
        orderId: orderId === NO_ORDER ? null : orderId,
      });
      toast.success("File updated");
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't update that file",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={Boolean(file)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Edit file details</DialogTitle>
          <DialogDescription>
            {file?.fileName} · {file ? formatFileSize(file.sizeBytes) : ""}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <DialogBody className="space-y-4">
            {error ? (
              <p className="text-[12px] text-destructive">{error}</p>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={fieldId("file-desc")}>Description</Label>
              <Textarea
                id={fieldId("file-desc")}
                rows={2}
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fieldId("file-visibility")}>Visibility</Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as FileVisibility)}
                disabled={saving}
              >
                <SelectTrigger id={fieldId("file-visibility")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FileVisibility.INTERNAL}>
                    {FILE_VISIBILITY_LABELS.INTERNAL}
                  </SelectItem>
                  <SelectItem value={FileVisibility.SHARED}>
                    {FILE_VISIBILITY_LABELS.SHARED}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {lockedOrderId ? null : orderOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("file-order")}>Related order</Label>
                <Select
                  value={orderId}
                  onValueChange={setOrderId}
                  disabled={saving}
                >
                  <SelectTrigger id={fieldId("file-order")}>
                    <SelectValue placeholder="Not related to an order" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ORDER}>
                      Not related to an order
                    </SelectItem>
                    {orderOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.orderNumber}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Relating a file moves it between Order Files views — it
                  is never copied.
                </p>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <LoadingButton type="submit" loading={saving} loadingText="Saving">
              Save changes
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
